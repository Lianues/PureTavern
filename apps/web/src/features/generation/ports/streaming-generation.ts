export interface StreamingGeneration {
  forward(response: Response): Response;
}

export class BrowserStreamingGeneration implements StreamingGeneration {
  forward(response: Response): Response {
    const contentType = response.headers.get('Content-Type') ?? 'text/event-stream; charset=utf-8';
    const transportHeader = response.headers.get('X-Pure-Tavern-Transport');
    const transport =
      transportHeader === 'local' || transportHeader === 'remote' ? transportHeader : 'direct';
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'X-Pure-Tavern-Provider': transport,
      },
    });
  }
}
