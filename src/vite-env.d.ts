/// <reference types="vite/client" />

declare module 'three/examples/jsm/libs/ktx-parse.module.js' {
  export const KHR_DF_MODEL_UASTC: number;
  export const KHR_DF_PRIMARIES_BT709: number;
  export const KHR_DF_PRIMARIES_UNSPECIFIED: number;
  export const KHR_DF_TRANSFER_SRGB: number;
  export const KHR_DF_TRANSFER_LINEAR: number;
  export interface KTX2Sample {
    bitOffset: number;
    bitLength: number;
    channelType: number;
    samplePosition: [number, number, number, number];
    sampleLower: number;
    sampleUpper: number;
  }
  export interface KTX2Container {
    vkFormat: number;
    typeSize: number;
    pixelWidth: number;
    pixelHeight: number;
    pixelDepth: number;
    layerCount: number;
    faceCount: number;
    levelCount: number;
    supercompressionScheme: number;
    levels: { levelData: Uint8Array; uncompressedByteLength: number }[];
    dataFormatDescriptor: {
      vendorId: number;
      descriptorType: number;
      versionNumber: number;
      colorModel: number;
      colorPrimaries: number;
      transferFunction: number;
      flags: number;
      texelBlockDimension: [number, number, number, number];
      bytesPlane: [number, number, number, number, number, number, number, number];
      samples: KTX2Sample[];
    }[];
    keyValue: Record<string, string | Uint8Array>;
  }
  export function createDefaultContainer(): KTX2Container;
  export function write(container: KTX2Container): Uint8Array;
  export function read(data: Uint8Array): KTX2Container;
}
