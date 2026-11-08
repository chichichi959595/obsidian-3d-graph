declare module 'virtual:web-assets' {
  export const WEB_ASSETS: Record<string, { type: string; data: string }>;
}

declare module 'virtual:hand-manifest' {
  export interface HandFile {
    path: string;
    url: string;
    size: number;
    sha256: string;
  }
  export const HAND_FILES: HandFile[];
}
