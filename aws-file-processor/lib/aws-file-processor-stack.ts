import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class AwsFileProcessorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const AMAZON_LINUX_2_AMI = ec2.MachineImage.latestAmazonLinux2({
      cpuType: ec2.AmazonLinuxCpuType.X86_64,
    }).getImage(this).imageId;

    // Import existing secret by name
    const openaiSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 
      'OpenAISecret',
      '/file-processor/openai-api-key'
    );

    // Create S3 Bucket with CORS
    const bucket = new s3.Bucket(this, 'FileProcessingBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins: ['*'], // In production, restrict to your domain
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
        },
      ],
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // upload our python processing script to s3 so ec2 can grab it
    const processingScript = new s3deploy.BucketDeployment(this, 'DeployProcessingScript', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../scripts'))],
      destinationBucket: bucket,
      destinationKeyPrefix: 'scripts'
    });
    
    // create dynamodb table
    const table = new dynamodb.Table(this, 'FileProcessingTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For development only
      pointInTimeRecovery: true,
    });

    // set up vpc with both public and private subnets
    const vpc = new ec2.Vpc(this, 'FileProcessingVPC', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // Create Security Group for EC2
    const ec2SecurityGroup = new ec2.SecurityGroup(this, 'EC2SecurityGroup', {
      vpc,
      description: 'Security group for File Processing EC2 instances',
      allowAllOutbound: true,
    });

    // Create EC2 Role and Instance Profile
    const ec2Role = new iam.Role(this, 'EC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    const ec2InstanceProfile = new iam.CfnInstanceProfile(this, 'EC2InstanceProfile', {
      roles: [ec2Role.roleName]
    });

    // Add DynamoDB permissions to EC2 role
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:UpdateItem',
          'dynamodb:PutItem'
        ],
        resources: [table.tableArn],
      })
    );

    // ec2 termination permissions
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:TerminateInstances'],
        resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/*`],
        conditions: {
          'StringEquals': {
            'aws:userid': '${aws:userid}'  // Only allow terminating its own instance
          }
        }
      })
    );

    // Add S3 read/write permissions for the EC2 role
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:GetObject',
          's3:PutObject',
          's3:ListBucket'
        ],
        resources: [
          bucket.bucketArn,
          `${bucket.bucketArn}/*`
        ],
      })
    );

    // Add CloudWatch Logs permissions to EC2 role
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogStreams'
        ],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/ec2/*`]
      })
    );

    // Create Lambda role !before! Lambda functions
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    // First, create the API Gateway with deployment enabled
    const api = new apigateway.RestApi(this, 'FileProcessingApi', {
      restApiName: 'File Processing Service',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: {
        stageName: 'prod',
        tracingEnabled: true,
      },
    });

    // Create the resources
    const files = api.root.addResource('files');
    const fileId = files.addResource('{id}');
    const process = fileId.addResource('process');
    const uploadUrl = api.root.addResource('upload-url');

    // Create the store metadata function with the API endpoint
    const storeMetadataFunction = new lambdaNodejs.NodejsFunction(this, 'StoreMetadataFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/store-metadata.ts'),
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        TABLE_NAME: table.tableName,
      },
      bundling: {
        externalModules: [
          'aws-sdk',
        ],
        nodeModules: [
          'uuid',
          '@aws-sdk/client-dynamodb'
        ],
      },
    });

    const triggerEc2Function = new lambdaNodejs.NodejsFunction(this, 'TriggerEc2Function', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'handler',
      entry: path.join(__dirname, '../lambda/trigger-ec2.ts'),
      role: lambdaRole,
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      environment: {
        TABLE_NAME: table.tableName,
        BUCKET_NAME: bucket.bucketName,
        AMI_ID: 'ami-012967cc5a8c9f891',
        EC2_ROLE_ARN: ec2InstanceProfile.attrArn,
        SECURITY_GROUP_ID: ec2SecurityGroup.securityGroupId,
        OPENAI_SECRET_ID: openaiSecret.secretName,
        VPC_ID: vpc.vpcId,
        SUBNET_TYPE: 'Private',
        EC2_TAGS: JSON.stringify([
          { Key: 'Name', Value: 'FileProcessor' },
          { Key: 'Project', Value: 'FileProcessing' }
        ])
      },
    });

    const generateUploadUrlFunction = new lambdaNodejs.NodejsFunction(
      this,
      'GenerateUploadUrlFunction',
      {
        runtime: lambda.Runtime.NODEJS_18_X,
        handler: 'handler',
        entry: path.join(__dirname, '../lambda/generate-upload-url.ts'),
        role: lambdaRole,
        environment: {
          BUCKET_NAME: bucket.bucketName,
        },
      }
    );

    // Add the request methods
    files.addMethod('POST', new apigateway.LambdaIntegration(storeMetadataFunction));
    process.addMethod('POST', new apigateway.LambdaIntegration(triggerEc2Function));
    uploadUrl.addMethod('GET', new apigateway.LambdaIntegration(generateUploadUrlFunction));

    // Add permissions to Lambda role
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [table.tableArn],
      })
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ec2:RunInstances',
          'ec2:CreateTags',
          'ec2:DescribeInstances',
          'ec2:DescribeSubnets',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeVpcs',
          'iam:PassRole'
        ],
        resources: ['*'], // Scope this down in production
      })
    );

    // Add permissions to Lambda role to read the secret
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [openaiSecret.secretArn],
      })
    );

    // Add permissions to EC2 role to read the secret
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [openaiSecret.secretArn],
      })
    );

    // Add permission to generate pre-signed URLs to the Lambda role
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [`${bucket.bucketArn}/*`],
      })
    );

    // Add after other S3 permissions
    bucket.grantRead(storeMetadataFunction);  // Store metadata needs to read files

    // Output important resource information
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 Bucket Name',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB Table Name',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `https://${api.restApiId}.execute-api.${this.region}.amazonaws.com/${api.deploymentStage.stageName}`,
      description: 'API Gateway URL',
    });

    table.grantReadWriteData(triggerEc2Function);

    // Grant S3 permissions
    bucket.grantWrite(generateUploadUrlFunction);
    bucket.grantReadWrite(ec2Role);

    // Grant Secrets Manager permissions
    openaiSecret.grantRead(ec2Role);
    openaiSecret.grantRead(triggerEc2Function);

    // Add explicit DynamoDB permissions
    table.grantWriteData(storeMetadataFunction);

    // Add execute-api permissions
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: [`arn:aws:execute-api:${this.region}:${this.account}:${api.restApiId}/*`],
      })
    );
  }
}
