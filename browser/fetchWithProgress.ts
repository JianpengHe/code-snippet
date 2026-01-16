type FetchProgress = {
  loaded: number;
  total: number;
  percent: number | null;
};

type FetchWithProgress = (
  input: RequestInfo | URL,
  init?: RequestInit,
  onProgress?: (progress: FetchProgress) => void
) => Promise<Response>;

export const fetchWithProgress: FetchWithProgress = async (input, init = {}, onProgress) => {
  const response = await fetch(input, init);

  // 如果没有回调，直接返回原 response
  if (!onProgress || !response.body) {
    return response;
  }

  const contentLength = response.headers.get("Content-Length");
  const total = contentLength ? Number(contentLength) : 0;

  const reader = response.body.getReader();
  let loaded = 0;
  let isStop = false;
  let RAFid: number | null = null;
  const RAF = () => {
    if (init.signal?.aborted) return;
    onProgress({
      loaded,
      total,
      percent: total ? loaded / total : null,
    });
    RAFid = isStop ? null : requestAnimationFrame(RAF);
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        RAFid = requestAnimationFrame(RAF);
        while (!init.signal?.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          loaded += value.byteLength;
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      } finally {
        controller.close();
        reader.releaseLock();
        isStop = true;
        if (RAFid) cancelAnimationFrame(RAFid);
        RAFid = null;
        // RAF();
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
