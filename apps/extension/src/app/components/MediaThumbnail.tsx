import {useEffect, useRef, useState} from 'react';
import {Center} from '@astryxdesign/core/Center';
import {HStack} from '@astryxdesign/core/Layout';
import {Icon} from '@astryxdesign/core/Icon';
import {Thumbnail} from '@astryxdesign/core/Thumbnail';
import type {ThumbnailProps} from '@astryxdesign/core/Thumbnail';
import {translate} from '../../i18n/core';
import type {MessageKey, ParamsFor} from '../../i18n/types';
import {useI18n} from '../../i18n';
import type {Media} from '../../../lib/types';

/**
 * Accepted as a parameter by `withVideoHint` (a plain, non-React helper kept
 * pure and unit-testable) instead of reading `useI18n()` itself. Defaults to
 * English (see `defaultT`) so existing callers that don't pass one keep
 * returning the same English copy they always have.
 */
type TranslateFn = <K extends MessageKey>(key: K, params?: ParamsFor<K>) => string;
const defaultT: TranslateFn = (key, params) => translate('en', key, params);

// A play triangle. Not in Astryx's semantic icon set (`astryx docs icons`),
// so it's passed to `Icon` as a direct SVG component, same as the pattern
// Astryx documents for custom glyphs.
function PlayGlyph(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M8 6.82v10.36a1 1 0 0 0 1.53.848l8.14-5.18a1 1 0 0 0 0-1.696l-8.14-5.18A1 1 0 0 0 8 6.82Z" />
    </svg>
  );
}

/**
 * Prefixes accessible text with a "Video" hint, unless it already mentions
 * video (so we never announce/show "Video — Video preview 1").
 */
function withVideoHint(text: string | undefined, isVideo: boolean, t: TranslateFn = defaultT): string | undefined {
  if (!isVideo || !text) return text;
  return /video/i.test(text) ? text : t('dashboard.card.videoHint', {text});
}

/**
 * Same lazy-mount behavior as BookmarkCard's local LazyThumbnail: defers
 * `src` until the thumbnail nears the viewport, so off-screen media doesn't
 * eagerly fetch.
 */
function LazyThumbnail({src, ...props}: Omit<ThumbnailProps, 'ref' | 'isLoading'>) {
  const targetRef = useRef<HTMLDivElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    if (!src || !target || isNearViewport) return;
    if (!('IntersectionObserver' in window)) {
      setIsNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      {rootMargin: '240px'},
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [isNearViewport, src]);

  return (
    <Thumbnail
      {...props}
      ref={targetRef}
      src={isNearViewport ? src : undefined}
      isLoading={!isNearViewport && Boolean(src)}
    />
  );
}

export interface MediaThumbnailProps extends Omit<ThumbnailProps, 'ref' | 'isLoading'> {
  /** Drives the video indicator; only `"video"` shows the play badge + hint. */
  mediaType: Media['type'];
  /** Mounts `src` lazily once the thumbnail nears the viewport. @default false */
  isLazy?: boolean;
}

/**
 * Wraps Astryx's `Thumbnail` (or a lazy-mounted variant) and, for video
 * media, overlays a subtle centered play glyph so a video's poster frame
 * can't be mistaken for a photo. The badge is `pointer-events: none` so it
 * never steals the Thumbnail's own click/hover/focus behavior, and the
 * accessible name/label gets a "Video" hint when it doesn't already have one.
 */
export function MediaThumbnail({mediaType, isLazy = false, alt, label, ...rest}: MediaThumbnailProps) {
  const {t} = useI18n();
  const isVideo = mediaType === 'video';
  const resolvedAlt = withVideoHint(alt, isVideo, t);
  const resolvedLabel = withVideoHint(label, isVideo, t);

  return (
    <HStack className="nook-media-thumbnail">
      {isLazy ? (
        <LazyThumbnail alt={resolvedAlt} label={resolvedLabel} {...rest} />
      ) : (
        <Thumbnail alt={resolvedAlt} label={resolvedLabel} {...rest} />
      )}
      {isVideo ? (
        <Center
          isInline
          width={24}
          height={24}
          className="nook-media-thumbnail-badge"
          aria-hidden="true">
          <Icon icon={PlayGlyph} size="sm" color="inherit" />
        </Center>
      ) : null}
    </HStack>
  );
}
