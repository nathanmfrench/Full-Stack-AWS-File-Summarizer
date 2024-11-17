import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

const s3Client = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME;
const URL_EXPIRATION = 300; // URL expires in 5 minutes

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    if (!event.queryStringParameters?.filename) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'Filename is required' }),
      };
    }

    const filename = event.queryStringParameters.filename;
    
    // Validate file type
    if (!filename.toLowerCase().endsWith('.txt')) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'Only .txt files are allowed' }),
      };
    }

    // Generate unique file path
    const fileId = uuidv4();
    const fileKey = `uploads/${fileId}-${filename}`;

    // Generate pre-signed URL
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey,
      ContentType: 'text/plain',
      ACL: 'bucket-owner-full-control',
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: URL_EXPIRATION,
    });

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*', // in production, we'll configure this to our domain
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET',
      },
      body: JSON.stringify({
        uploadUrl,
        fileKey,
        expiresIn: URL_EXPIRATION,
      }),
    };
  } catch (error) {
    console.error('Error generating pre-signed URL:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Error generating upload URL' }),
    };
  }
}
