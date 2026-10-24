import axios from "axios";
import * as cheerio from "cheerio";
import type { ProviderContext } from "../../providers/vega/types";

const commonHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
} as Record<string, string>;

const http = axios.create({
  headers: commonHeaders,
  timeout: 20000,
  maxRedirects: 5,
});

const kv = new Map<string, unknown>();

export const providerContext: ProviderContext = {
  axios: http as unknown as typeof axios,
  commonHeaders,
  cheerio,
  openWebView: async () => {
    throw new Error("openWebView is not supported in Priva Embed");
  },
  kvStore: {
    get: async <T = unknown>(key: string): Promise<T | undefined> =>
      kv.get(key) as T | undefined,
    set: async (key: string, value: unknown): Promise<void> => {
      kv.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => kv.delete(key),
    keys: async (): Promise<string[]> => Array.from(kv.keys()),
    clear: async (): Promise<void> => {
      kv.clear();
    },
  },
};
