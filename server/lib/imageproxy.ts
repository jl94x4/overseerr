import logger from '@server/logger';
import axios from 'axios';
import rateLimit, { type rateLimitOptions } from 'axios-rate-limit';
import { createHash } from 'crypto';
import { promises } from 'fs';
import path, { join } from 'path';

type ImageResponse = {
  meta: {
    revalidateAfter: number;
    curRevalidate: number;
    isStale: boolean;
    etag: string;
    extension: string;
    cacheKey: string;
    cacheMiss: boolean;
  };
  imageBuffer: Buffer;
};

class ImageProxy {
  private axios;
  private cacheVersion;
  private key;

  constructor(
    key: string,
    baseUrl: string,
    options: {
      cacheVersion?: number;
      rateLimitOptions?: rateLimitOptions;
    } = {}
  ) {
    this.cacheVersion = options.cacheVersion ?? 1;
    this.key = key;
    this.axios = axios.create({
      baseURL: baseUrl,
    });

    if (options.rateLimitOptions) {
      this.axios = rateLimit(this.axios, options.rateLimitOptions);
    }
  }

  public async getImage(path: string): Promise<ImageResponse> {
    const cacheKey = this.getCacheKey(path);

    const imageResponse = await this.get(cacheKey);

    if (!imageResponse) {
      const newImage = await this.set(path, cacheKey);

      if (!newImage) {
        throw new Error('Failed to load image');
      }

      return newImage;
    }

    // If the image is stale, we will revalidate it in the background.
    if (imageResponse.meta.isStale) {
      this.set(path, cacheKey);
    }

    return imageResponse;
  }

  private async get(cacheKey: string): Promise<ImageResponse | null> {
    try {
      const directory = join(this.getCacheDirectory(), cacheKey);
      const files = await promises.readdir(directory);
      const now = Date.now();

      for (const file of files) {
        const [maxAgeSt, expireAtSt, etag, extension] = file.split('.');
        const buffer = await promises.readFile(join(directory, file));
        const expireAt = Number(expireAtSt);
        const maxAge = Number(maxAgeSt);

        return {
          meta: {
            curRevalidate: maxAge,
            revalidateAfter: maxAge * 1000 + now,
            isStale: now > expireAt,
            etag,
            extension,
            cacheKey,
            cacheMiss: false,
          },
          imageBuffer: buffer,
        };
      }
    } catch (e) {
      // No files. Treat as empty cache.
    }

    return null;
  }

  private async set(
    path: string,
    cacheKey: string
  ): Promise<ImageResponse | null> {
    try {
      const directory = join(this.getCacheDirectory(), cacheKey);
      const response = await this.axios.get(path, {
        responseType: 'arraybuffer',
      });

      const buffer = Buffer.from(response.data, 'binary');
      const extension = path.split('.').pop() ?? '';
      const maxAge = Number(response.headers['cache-control'].split('=')[1]);
      const expireAt = Date.now() + maxAge * 1000;
      const etag = response.headers.etag.replace(/"/g, '');

      await this.writeToCacheDir(
        directory,
        extension,
        maxAge,
        expireAt,
        buffer,
        etag
      );

      return {
        meta: {
          curRevalidate: maxAge,
          revalidateAfter: expireAt,
          isStale: false,
          etag,
          extension,
          cacheKey,
          cacheMiss: true,
        },
        imageBuffer: buffer,
      };
    } catch (e) {
      logger.debug('Something went wrong caching image.', {
        label: 'Image Cache',
        errorMessage: e.message,
      });
      return null;
    }
  }

  private async writeToCacheDir(
    dir: string,
    extension: string,
    maxAge: number,
    expireAt: number,
    buffer: Buffer,
    etag: string
  ) {
    const filename = join(dir, `${maxAge}.${expireAt}.${etag}.${extension}`);

    await promises.rm(dir, { force: true, recursive: true }).catch(() => {
      // do nothing
    });

    await promises.mkdir(dir, { recursive: true });
    await promises.writeFile(filename, buffer);
  }

  private getCacheKey(path: string) {
    return this.getHash([this.key, this.cacheVersion, path]);
  }

  private getHash(items: (string | number | Buffer)[]) {
    const hash = createHash('sha256');
    for (const item of items) {
      if (typeof item === 'number') hash.update(String(item));
      else {
        hash.update(item);
      }
    }
    // See https://en.wikipedia.org/wiki/Base64#Filenames
    return hash.digest('base64').replace(/\//g, '-');
  }

  private getCacheDirectory() {
    return path.join(__dirname, '../../config/cache/images/', this.key);
  }
}

export default ImageProxy;