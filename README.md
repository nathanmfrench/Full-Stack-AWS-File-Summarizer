# Full Stack File Summarizer

## Video demo
 - file-processor-demo.mp4 file located in this repository

## Architecture Flow (overview)
- User uploads text file or types input via frontend
- File is stored in S3
- Metadata stored in DynamoDB
- EC2 instance spawned for processing file
- OpenAI generates summary
- Results stored back in S3 and DynamoDB
- EC2 instance self-terminates

## Architecture Diagram

![aws-full-stack-flow](https://github.com/user-attachments/assets/ca751784-9f32-4981-9cfc-348b0eb1b1aa)

## Infrastructure Components

### Frontend
- React w/ app router
- Server-side api routes
- Tailwind
- Typescript

### Backend 
1. S3 Bucket (w/ serverside encryption)

2. DynamoDB
   - Schema:
     ```
     {
       id: string (UUID),
       text: string,
       summary: string | null,
       file_path: string,
       output_file_path: string | null
     }
     ```

3. AWS API Gateway

4. Lambda Functions (generate presigned URLs for direct file upload from frontend, store metadata, trigger ec2 processing)

5. EC2 (auto creation/temination, openai processing script, downloads script from S3 and updates DynamoDB w/ results

## Security features
- No public S3 access
- No hardcoded credentials
- Secure credential management
- EC2 auto-termination
- Private subnet deployment

## Deployment Instructions

### Before Getting Started
Make sure you have:
- Node.js 18+ installed
- AWS account with billing set up
- OpenAI account with API access
- Git installed

### Setup

1. **Install AWS CLI**

**Windows:**
- Download and run AWS CLI installer from the AWS website

**Mac/Linux:**
```bash
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install
```

2) **Configure the AWS CLI with your credentials.** These credentials can be found on your AWS console (go to aws console, click your username in the top right, click security credentials, create new access key)

Now run:
```aws configure```

You'll have to enter:
- AWS Access Key ID
- AWS Secret Access Key
- Default region name (e.g., us-east-1)
- Default output format (make sure this is json)

3) **Now you'll need to setup your IAM resources and CDK.**
Through AWS Console:
- IAM → Users → Create User
- Attach policies for: SecretsManager, S3, DynamoDB, Lambda, EC2

4) **Bootstrap the AWS CDK**
```
npm install -g aws-cdk
cdk bootstrap
```

 5) **clone repo and install dependencies**
```
git clone https://github.com/nathanmfrench/profound-assessment.git
cd profound-assessment
npm install
```


7) **Obtain API key from OpenAI and store it using AWS Secrets Manager**
```
aws secretsmanager create-secret --name "/file-processor/openai-api-key" --secret-string "your key name here"
```

8) **Deploy all AWS resources (in backend)**

```
cd aws-file-processor
npx cdk deploy
```

9) **Setup and run frontend**

```
cd file-processor-frontend
```
now create your .env.local file in this directory, and populate it with your api gateway endpoint:
```
API_GATEWAY_ENDPOINT=https://[your-api-id].execute-api.[region].amazonaws.com/prod
```

This endpoint can be found through the AWS console, or through the CLI as follows:

```
aws cloudformation describe-stacks --stack-name [insert stack name here] --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text
```
Now run the following commands to install npm and start the frontend
```
npm install
npm run dev
```

10) **Now, a local server should be spun up on localhost:3000, just submit a .txt file or type in the input box and you'll see a success message when its uploaded. You'll can check the DynamoDB table through the AWS Console, or through the cli with the commands**
```
aws dynamodb list-tables
```

```
aws dynamodb scan \
    --table-name "[table name here]"
```

## Note
To deallocate the stack when finished, run:
```npx cdk destroy```


