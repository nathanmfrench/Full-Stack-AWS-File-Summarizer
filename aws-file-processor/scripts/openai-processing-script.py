import sys
import boto3
import os
import json
from openai import OpenAI
from botocore.exceptions import ClientError
import requests
from botocore.config import Config
from ec2_metadata import ec2_metadata

# Initialize AWS clients
region = 'us-east-1'
session = boto3.Session(region_name=region)
s3 = session.client('s3')
dynamodb = session.resource('dynamodb')
ec2 = session.client('ec2')
secrets = session.client('secretsmanager')

# Get OpenAI API key from environment variable
api_key = os.environ.get('OPENAI_API_KEY')
if not api_key:
    raise ValueError("OPENAI_API_KEY environment variable not set")

# Initialize OpenAI client
client = OpenAI(api_key=api_key)

def get_file_info(file_id):
    """Retrieve file information from DynamoDB"""
    table = dynamodb.Table(os.environ.get('TABLE_NAME'))
    try:
        response = table.get_item(Key={'id': file_id})
        return response.get('Item')
    except ClientError as e:
        print(f"Error getting item from DynamoDB: {e}")
        raise

def download_file(bucket, file_path, local_path):
    """Download file from S3"""
    try:
        print(f"Downloading file:")
        print(f"  From bucket: {bucket}")
        print(f"  From path: {file_path}")
        print(f"  To local path: {local_path}")
        
        # First check if file exists
        try:
            s3.head_object(Bucket=bucket, Key=file_path)
        except Exception as e:
            print(f"File does not exist in S3: {e}")
            print(f"Available files in bucket:")
            response = s3.list_objects_v2(Bucket=bucket, Prefix='uploads/')
            for obj in response.get('Contents', []):
                print(f"  - {obj['Key']}")
            raise
            
        s3.download_file(bucket, file_path, local_path)
        print("Download successful")
    except ClientError as e:
        print(f"Error downloading file from S3: {e}")
        print(f"Error details: {str(e)}")
        raise

def generate_summary(text_content):
    """Generate summary using OpenAI"""
    try:
        print(f"Generating summary for text: {text_content[:100]}...")  # First 100 chars
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": "You are a helpful assistant that creates concise summaries."},
                {"role": "user", "content": f"Please provide a concise summary of the following text:\n\n{text_content}"}
            ],
            max_tokens=150
        )
        summary = response.choices[0].message.content.strip()
        print(f"Generated summary: {summary}")
        return summary
    except Exception as e:
        print(f"Error generating summary with OpenAI: {e}")
        raise

def update_dynamodb(file_id, summary, output_path):
    """Update DynamoDB with summary and output file path"""
    table = dynamodb.Table(os.environ.get('TABLE_NAME'))
    try:
        print(f"Updating DynamoDB - File ID: {file_id}")
        print(f"Output path to be stored: {output_path}")
        
        update_expression = 'SET summary = :summary, output_file_path = :output_path'
        expression_values = {
            ':summary': summary,
            ':output_path': output_path
        }

        response = table.update_item(
            Key={'id': file_id},
            UpdateExpression=update_expression,
            ExpressionAttributeValues=expression_values,
            ReturnValues='ALL_NEW',
            ConditionExpression='attribute_exists(id)'
        )
        print(f"DynamoDB update response: {json.dumps(response, indent=2)}")
        return response
    except Exception as e:
        print(f"Error updating DynamoDB: {e}")
        raise

def terminate_instance():
    """Terminate the current EC2 instance"""
    try:
        # Get instance ID using ec2-metadata helper
        instance_id = ec2_metadata.instance_id
        region = ec2_metadata.region
        print(f"Current instance: {instance_id} in region {region}")
        
        # Configure boto3 with retry configuration
        config = Config(
            region_name=region,
            retries = dict(
                max_attempts = 3,
                mode = 'adaptive'
            )
        )
        
        ec2_client = boto3.client('ec2', config=config)
        print(f"Terminating instance {instance_id}")
        
        response = ec2_client.terminate_instances(InstanceIds=[instance_id])
        print(f"Termination response: {response}")
        
    except Exception as e:
        print(f"Error in terminate_instance: {e}")
        print("Continuing with shutdown despite error...")

def debug_file_info(file_info, bucket_name):
    """Debug helper to print file information"""
    print("=== Debug File Info ===")
    print(f"File Info from DynamoDB: {json.dumps(file_info, indent=2)}")
    print(f"Bucket Name: {bucket_name}")
    print(f"File Path in DynamoDB: {file_info.get('file_path')}")
    print("=====================")

def main():
    if len(sys.argv) != 2:
        print("Usage: python process.py <file_id>")
        sys.exit(1)

    file_id = sys.argv[1]
    print(f"Processing file ID: {file_id}")
    
    try:
        # Get file info from DynamoDB
        file_info = get_file_info(file_id)
        print(f"Retrieved file info from DynamoDB: {json.dumps(file_info, indent=2)}")
        
        if not file_info:
            raise Exception(f"No file info found for ID: {file_id}")

        bucket_name = os.environ.get('BUCKET_NAME')
        print(f"Bucket name from environment: {bucket_name}")
        
        input_file_path = file_info['file_path']
        print(f"Original file path from DynamoDB: {input_file_path}")
        
        # Remove 'undefined/' if it exists
        if input_file_path.startswith('undefined/'):
            input_file_path = input_file_path.replace('undefined/', '', 1)
        
        # Strip bucket name if it exists
        if input_file_path.startswith(f"{bucket_name}/"):
            input_file_path = input_file_path.replace(f"{bucket_name}/", "", 1)
            
        print(f"Cleaned file path: {input_file_path}")
        
        file_name = input_file_path.split('/')[-1]
        base_name = os.path.splitext(file_name)[0]
        print(f"File name: {file_name}")
        print(f"Base name: {base_name}")
        
        # Download input file
        local_input_path = f'/tmp/{file_name}'
        print(f"Attempting to download from:")
        print(f"  Bucket: {bucket_name}")
        print(f"  Path: {input_file_path}")
        print(f"  To local path: {local_input_path}")
        
        download_file(bucket_name, input_file_path, local_input_path)

        # Read file content
        with open(local_input_path, 'r') as file:
            content = file.read()

        # Generate summary
        summary = generate_summary(content)

        # Create output file with summary
        local_output_path = f'/tmp/{base_name}_output.txt'
        with open(local_output_path, 'w') as file:
            file.write(f"{content}\n\nSummary:\n{summary}")

        # Upload output file
        output_file_path = f'output/{base_name}_output.txt'
        s3.upload_file(local_output_path, bucket_name, output_file_path)

        # Create full output path for DynamoDB
        full_output_path = f'{bucket_name}/{output_file_path}'
        
        # Before updating DynamoDB
        print(f"Summary generated: {summary}")
        print(f"Full output path: {full_output_path}")

        # Update DynamoDB with full path including bucket
        update_dynamodb(file_id, summary, full_output_path)

        # After updating DynamoDB
        print("DynamoDB update completed")

        # Clean up local files
        os.remove(local_input_path)
        os.remove(local_output_path)

    except Exception as e:
        print(f"Error processing file: {e}")
        sys.exit(1)
    finally:
        # Always terminate the instance when done
        terminate_instance()

if __name__ == "__main__":
    main()