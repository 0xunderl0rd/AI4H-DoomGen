/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENAI_API_KEY?: string;
  readonly VITE_OPENAI_MODEL?: string;
  readonly VITE_OPENAI_IMAGE_MODEL?: string;
  readonly VITE_ELEVENLABS_API_KEY?: string;
  readonly VITE_ELEVENLABS_BASE_URL?: string;
  readonly VITE_ELEVENLABS_VOICE_ID?: string;
  readonly VITE_DOOM_WASM_JS_URL?: string;
  readonly VITE_DOOM_WASM_WAD_URL?: string;
  readonly VITE_USE_DOOM_WASM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
