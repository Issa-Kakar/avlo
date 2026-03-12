/**
 * Image Decode Worker
 *
 * Decodes image blobs into ImageBitmap off the main thread.
 * createImageBitmap is the heavy operation — must not block UI.
 */

export interface DecodeRequest {
  type: 'decode';
  id: string;
  blob: Blob;
}

export interface DecodeSuccess {
  type: 'decoded';
  id: string;
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export interface DecodeError {
  type: 'error';
  id: string;
  message: string;
}

export type WorkerResponse = DecodeSuccess | DecodeError;

self.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const { id, blob } = e.data;
  try {
    const bitmap = await createImageBitmap(blob);
    (self as unknown as Worker).postMessage(
      { type: 'decoded', id, bitmap, width: bitmap.width, height: bitmap.height } satisfies DecodeSuccess,
      [bitmap] as unknown as Transferable[],
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'error',
      id,
      message: err instanceof Error ? err.message : 'decode failed',
    } satisfies DecodeError);
  }
};
