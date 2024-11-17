import { NextResponse } from 'next/server';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    
    if (!id) {
      return NextResponse.json(
        { error: 'Missing file ID' },
        { status: 400 }
      );
    }

    const apiUrl = `${process.env.API_GATEWAY_ENDPOINT}/files/${id}/process`;
    
    // Debug logs
    console.log('Processing request for file:', {
      id,
      apiUrl,
      apiGatewayEndpoint: process.env.API_GATEWAY_ENDPOINT
    });
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Debug response
    console.log('Process response:', {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries())
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Process request failed:', {
        status: response.status,
        error: errorText
      });
      throw new Error(`AWS API request failed: ${errorText}`);
    }

    const data = await response.json();
    console.log('Process success:', data);
    
    return NextResponse.json(data);
  } catch (error) {
    console.error('Process route error:', {
      error,
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
