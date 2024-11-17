// get the aws stuff we need
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { v4 as uuidv4 } from 'uuid';

// set up our connection to dynamodb
const dynamodb = new DynamoDBClient({});

// define what our file metadata looks like
interface FileMetadata {
  text: string;
  file_path: string;
}

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    // log the incoming request for debugging
    console.log('Event:', JSON.stringify(event, null, 2));
    
    // make sure we got a request body
    if (!event.body) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: 'missing request body' })
      };
    }

    // pull out the text and file path from the request
    const { text, file_path }: FileMetadata = JSON.parse(event.body);
    
    // make sure we have both text and file path
    if (!text || !file_path) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          message: 'missing required fields. both text and file_path are required.' 
        })
      };
    }

    // create a unique id for this file
    const id = uuidv4();
    console.log('generated id:', id);

    // save everything to dynamodb
    await dynamodb.send(
      new PutItemCommand({
        TableName: process.env.TABLE_NAME,
        Item: {
          id: { S: id },
          text: { S: text },
          file_path: { S: file_path },
          summary: { NULL: true },          // will be filled in later by ec2
          output_file_path: { NULL: true }  // will be filled in later by ec2
        }
      })
    );

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        id,
        message: 'metadata stored successfully',
        data: {
          id,
          text,
          file_path,
          summary: null,
          output_file_path: null
        }
      })
    };

  } catch (error) {
    // log it and let the user know
    console.error('lambda error:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'internal server error',
        error: error instanceof Error ? error.message : 'unknown error'
      })
    };
  }
}