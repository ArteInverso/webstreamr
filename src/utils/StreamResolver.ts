import { ContentType, Stream } from 'stremio-addon-sdk';
import winston from 'winston';
import bytes from 'bytes';
import { Context, TIMEOUT, UrlResult } from '../types';
import { Source } from '../source';
import { BlockedError, HttpError, NotFoundError, QueueIsFullError } from '../error';
import { flagFromCountryCode, languageFromCountryCode } from './language';
import { envGetAppName } from './env';
import { Id } from './id';
import { ExtractorRegistry } from '../extractor';
import { showExternalUrls } from './config';

interface ResolveResponse {
  streams: Stream[];
  ttl?: number;
}

export class StreamResolver {
  private readonly logger: winston.Logger;
  private readonly extractorRegistry: ExtractorRegistry;

  public constructor(logger: winston.Logger, extractorRegistry: ExtractorRegistry) {
    this.logger = logger;
    this.extractorRegistry = extractorRegistry;
  }

  public readonly resolve = async (ctx: Context, sources: Source[], type: ContentType, id: Id): Promise<ResolveResponse> => {
    if (sources.length === 0) {
      return {
        streams: [
          {
            name: 'WebStreamr',
            title: '⚠️ No sources found. Please re-configure the plugin.',
            ytId: 'E4WlUXrJgy4',
          },
        ],
      };
    }

    const streams: Stream[] = [];

    let handlerErrorOccurred = false;
    const urlResults: UrlResult[] = [];
    const handlerPromises = sources.map(async (handler) => {
      if (!handler.contentTypes.includes(type)) {
        return;
      }

      try {
        const handleResults = await handler.handle(ctx, type, id);
        this.logger.info(`${handler.id} returned ${handleResults.length} urls`, ctx);

        const handlerUrlResults = await Promise.all(
          handleResults.map(async ({ countryCode, referer, title, url }) => {
            const newCtx = { ...ctx, ...(referer && { referer }) };

            return await this.extractorRegistry.handle(newCtx, url, countryCode, title);
          }),
        );

        urlResults.push(...handlerUrlResults.flat());
      } catch (error) {
        if (error instanceof NotFoundError) {
          return;
        }

        handlerErrorOccurred = true;

        streams.push({
          name: envGetAppName(),
          title: [`🔗 ${handler.label}`, this.logErrorAndReturnNiceString(ctx, handler.id, error)].join('\n'),
          ytId: 'E4WlUXrJgy4',
        });
      }
    });
    await Promise.all(handlerPromises);

    urlResults.sort((a, b) => {
      const heightComparison = (b.meta.height ?? 0) - (a.meta.height ?? 0);
      if (heightComparison !== 0) {
        return heightComparison;
      }

      const bytesComparison = (b.meta.bytes ?? 0) - (a.meta.bytes ?? 0);
      if (bytesComparison !== 0) {
        return bytesComparison;
      }

      if (a.isExternal || b.isExternal) {
        return a.isExternal ? 1 : -1;
      }

      return a.label.localeCompare(b.label);
    });

    this.logger.info(`Return ${urlResults.length} streams`, ctx);

    streams.push(
      ...urlResults.filter(urlResult => !urlResult.isExternal || showExternalUrls(ctx.config) || urlResult.error)
        .map(urlResult => ({
          ...this.buildUrl(ctx, urlResult),
          name: this.buildName(ctx, urlResult),
          title: this.buildTitle(ctx, urlResult),
          behaviorHints: {
            ...(urlResult.sourceId && { bingeGroup: `webstreamr-${urlResult.sourceId}` }),
            ...(urlResult.requestHeaders !== undefined && {
              notWebReady: true,
              proxyHeaders: { request: urlResult.requestHeaders },
            }),
            ...(urlResult.meta.bytes && { videoSize: urlResult.meta.bytes }),
          },
        })),
    );

    const ttl = !handlerErrorOccurred ? this.determineTtl(urlResults) : undefined;

    return {
      streams,
      ...(ttl && { ttl }),
    };
  };

  private readonly determineTtl = (urlResults: UrlResult[]): number | undefined => {
    if (!urlResults.length) {
      return 900000; // 15m
    }

    if (urlResults.some(urlResult => urlResult.ttl === undefined)) {
      return undefined;
    }

    return Math.min(...urlResults.map(urlResult => urlResult.ttl as number));
  };

  private readonly buildUrl = (ctx: Context, urlResult: UrlResult): { externalUrl: string } | { url: string } | { ytId: string } => {
    if (!urlResult.isExternal) {
      return { url: urlResult.url.href };
    }

    if (showExternalUrls(ctx.config)) {
      return { externalUrl: urlResult.url.href };
    }

    return { ytId: 'E4WlUXrJgy4' };
  };

  private readonly buildName = (ctx: Context, urlResult: UrlResult): string => {
    let name = envGetAppName();

    name += urlResult.meta.height ? ` ${urlResult.meta.height}P` : ' N/A';

    if (urlResult.isExternal && showExternalUrls(ctx.config)) {
      name += ` ⚠️ external`;
    }

    return name;
  };

  private readonly logErrorAndReturnNiceString = (ctx: Context, source: string, error: unknown): string => {
    if (error instanceof BlockedError) {
      if (error.reason === 'cloudflare_challenge') {
        this.logger.warn(`${source}: Request was blocked via Cloudflare challenge.`, ctx);
      } else {
        this.logger.warn(`${source}: Request was blocked, headers: ${JSON.stringify(error.headers)}.`, ctx);
      }

      return '⚠️ Request was blocked.';
    }

    if (error === TIMEOUT) {
      this.logger.warn(`${source}: Request timed out.`, ctx);

      return '🐢 Request timed out.';
    }

    if (error instanceof QueueIsFullError) {
      this.logger.warn(`${source}: Request queue is full.`, ctx);

      return '⏳ Request queue is full. Please try again later or consider self-hosting.';
    }

    if (error instanceof HttpError) {
      this.logger.error(`${source}: HTTP status ${error.status} (${error.statusText}), headers: ${JSON.stringify(error.headers)}, stack: ${error.stack}.`, ctx);
      return `❌ Request failed with status ${error.status} (${error.statusText}). Request-id: ${ctx.id}.`;
    }

    const cause = (error as Error & { cause?: unknown }).cause;
    this.logger.error(`${source} error: ${error}, cause: ${cause}, stack: ${(error as Error).stack}`, ctx);

    return `❌ Request failed. Request-id: ${ctx.id}.`;
  };

  private readonly buildTitle = (ctx: Context, urlResult: UrlResult): string => {
    const titleLines = [];

    if (urlResult.meta.title) {
      titleLines.push(`📂 ${urlResult.meta.title}`);
    }

    if (urlResult.meta.bytes) {
      titleLines.push(`💾 ${bytes.format(urlResult.meta.bytes, { unitSeparator: ' ' })}`);
    }

    titleLines.push(`🌐 ${languageFromCountryCode(urlResult.meta.countryCode)} ${flagFromCountryCode(urlResult.meta.countryCode)}`);
    titleLines.push(`🔗 ${urlResult.label}`);

    if (urlResult.error) {
      titleLines.push(this.logErrorAndReturnNiceString(ctx, urlResult.sourceId, urlResult.error));
    }

    return titleLines.join('\n');
  };
}
