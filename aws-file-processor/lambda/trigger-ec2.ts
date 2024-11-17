import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { EC2Client, RunInstancesCommand, DescribeSubnetsCommand } from '@aws-sdk/client-ec2';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

//initialize ec2 and dynamo clients
const ec2 = new EC2Client({});
const dynamodb = new DynamoDBClient({});

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    console.log('Trigger EC2 Lambda started', { event });
    const fileId = event.pathParameters?.id;
    //make sure that we have a file for processing
    if (!fileId) {
      console.log('No fileId provided');
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'Missing file ID' }),
      };
    }

    console.log('Launching EC2 instance for file:', fileId);

    // Add dynamodb query
    const fileData = await dynamodb.send(
      new GetItemCommand({
        TableName: process.env.TABLE_NAME!,
        Key: {
          id: { S: fileId }
        }
      })
    );

    if (!fileData.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: 'File not found' }),
      };
    }

    // grab private subnets for our ec2 instance
    const subnets = await ec2.send(
      new DescribeSubnetsCommand({
        Filters: [
          {
            Name: 'vpc-id',
            Values: [process.env.VPC_ID!],
          },
          {
            Name: 'tag:Name',
            Values: ['*Private*'], 
          },
        ],
      })
    );
    //make sure we can find the private subnet
    if (!subnets.Subnets?.[0]?.SubnetId) {
      throw new Error('No private subnet found');
    }

    // python script to aunch EC2 instance
    const userData = Buffer.from(`#!/bin/bash
# Enable logging to CloudWatch
curl https://s3.amazonaws.com/aws-cloudwatch/downloads/latest/awslogs-agent-setup.py -O
chmod +x ./awslogs-agent-setup.py
cat > awslogs.conf << 'EOF'
[general]
state_file = /var/awslogs/state/agent-state

[/var/log/user-data.log]
file = /var/log/user-data.log
log_group_name = /ec2/user-data-logs
log_stream_name = {instance_id}
datetime_format = %Y-%m-%d %H:%M:%S
EOF

./awslogs-agent-setup.py -n -r ${process.env.CDK_DEFAULT_REGION} -c awslogs.conf

# Enable logging
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1

echo "Starting setup..."

# Create a virtual environment to avoid package conflicts
python3 -m venv /tmp/venv
source /tmp/venv/bin/activate

# Install packages in the virtual environment
pip3 install --no-cache-dir boto3 openai requests ec2-metadata

echo "Packages installed"

# Get and export OpenAI API key - THIS IS THE FIXED PART
echo "Getting OpenAI API key..."
export OPENAI_API_KEY=\$(aws secretsmanager get-secret-value \
  --secret-id "/file-processor/openai-api-key" \
  --query 'SecretString' \
  --output text)

# Verify the key is set
echo "Verifying API key..."
if [ -z "\$OPENAI_API_KEY" ]; then
    echo "Error: OPENAI_API_KEY is empty"
    exit 1
else
    echo "OPENAI_API_KEY is set (starts with \${OPENAI_API_KEY:0:5}...)"
fi

export TABLE_NAME=${process.env.TABLE_NAME}
export BUCKET_NAME=${process.env.BUCKET_NAME}

echo "Environment variables set"

# Download processing script
echo "Downloading processing script..."
aws s3 cp s3://${process.env.BUCKET_NAME}/scripts/openai-processing-script.py /tmp/process.py

echo "Running processing script..."
python3 /tmp/process.py ${fileId}

echo "Processing complete"
`).toString('base64');

    const runInstancesResponse = await ec2.send(
      new RunInstancesCommand({
        ImageId: process.env.AMI_ID,
        InstanceType: 't2.micro',
        MinCount: 1,
        MaxCount: 1,
        UserData: userData,
        SubnetId: subnets.Subnets[0].SubnetId,
        IamInstanceProfile: {
          Arn: process.env.EC2_ROLE_ARN,
        },
        SecurityGroupIds: [process.env.SECURITY_GROUP_ID!],
        TagSpecifications: [
          {
            ResourceType: 'instance',
            Tags: [
              {
                Key: 'Name',
                Value: `FileProcessor-${fileId}`,
              },
              {
                Key: 'AutoShutdown',
                Value: 'true',
              },
            ],
          },
        ],
      })
    );

    if (!runInstancesResponse.Instances?.[0]?.InstanceId) {
      throw new Error('Failed to launch EC2 instance');
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: 'Processing started',
        instanceId: runInstancesResponse.Instances[0].InstanceId
      }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        message: 'Internal server error',
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
    };
  }
}
