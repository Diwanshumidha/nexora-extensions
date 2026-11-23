// esbuild embeds .wasm files as bytes (see scripts/build-extension.mjs).
declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}

declare module "heic-decode" {
  interface Decoded {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }
  function decode(input: { buffer: Uint8Array }): Promise<Decoded>;
  export default decode;
}
