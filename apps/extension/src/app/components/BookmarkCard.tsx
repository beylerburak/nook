import {memo, useEffect, useRef, useState} from 'react';
import {Avatar} from '@astryxdesign/core/Avatar';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Grid} from '@astryxdesign/core/Grid';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Link} from '@astryxdesign/core/Link';
import {Section} from '@astryxdesign/core/Section';
import {Text} from '@astryxdesign/core/Text';
import {Thumbnail} from '@astryxdesign/core/Thumbnail';
import type {ThumbnailProps} from '@astryxdesign/core/Thumbnail';
import {Timestamp} from '@astryxdesign/core/Timestamp';
import type {Bookmark, Media} from '../../../lib/types';

export interface BookmarkCardProps {
  item: Bookmark;
  listLabel: string;
  onOpenDetails?: (item: Bookmark) => void;
  onOpenUrl?: (url: string, item: Bookmark) => void;
  onCopy?: (item: Bookmark) => void;
  onDelete?: (item: Bookmark) => void;
  onTag?: (item: Bookmark, tag: string) => void;
  onList?: (item: Bookmark) => void;
  onMedia?: (media: Media, item: Bookmark) => void;
}

type PreviewMedia = Media & {thumbnailUrl?: string; previewUrl?: string};

function LazyThumbnail({src, ...props}: Omit<ThumbnailProps, 'ref' | 'isLoading'>) {
  const targetRef = useRef<HTMLDivElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    if (!src || !target || isNearViewport) return;
    if (!("IntersectionObserver" in window)) {
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

function getBookmarkText(item: Bookmark): string | undefined {
  return item.description || item.shortDescription || item.title;
}

function getDate(item: Bookmark): string | undefined {
  const value = item.savedAt || item.createdAt || item.updatedAt;
  if (!value) return undefined;
  return Number.isNaN(new Date(value).getTime()) ? undefined : value;
}

function getMedia(item: Bookmark): Media[] {
  return item.media?.length ? item.media : item.attachments || [];
}

export const BookmarkCard = memo(function BookmarkCard({
  item,
  listLabel,
  onOpenDetails,
  onOpenUrl,
  onCopy,
  onDelete,
  onTag,
  onList,
  onMedia,
}: BookmarkCardProps) {
  const creatorName = item.creator?.name || item.creator?.handle || 'Unknown author';
  const postText = getBookmarkText(item);
  const date = getDate(item);
  const mediaItems = getMedia(item);
  const url = item.url || item.urls?.[0] || undefined;

  return (
    <Card className="nook-bookmark-card">
      <VStack gap={4}>
        <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
          <HStack gap={3} vAlign="center">
            <Avatar
              name={creatorName}
              src={item.creator?.avatar || undefined}
              size="sm"
            />
            <VStack gap={0}>
              <Text type="label" weight="semibold">{creatorName}</Text>
              {item.creator?.handle ? (
                <Text type="supporting" color="secondary">@{item.creator.handle}</Text>
              ) : null}
            </VStack>
          </HStack>
          {date ? <Timestamp value={date} format="auto" /> : null}
        </HStack>

        {item.title ? <Text type="large" weight="semibold">{item.title}</Text> : null}
        {postText ? <Text type="body" textWrap="pretty">{postText}</Text> : null}

        {item.note ? (
          <Section variant="muted" padding={3}>
            <VStack gap={1}>
              <Text type="supporting" weight="semibold">Your note</Text>
              <Text type="body">{item.note}</Text>
            </VStack>
          </Section>
        ) : null}

        {item.quote ? (
          <Section variant="muted" padding={3}>
            <VStack gap={2}>
              <Text type="supporting" weight="semibold">
                {item.quote.creator?.name || item.quote.creator?.handle || 'Quoted post'}
              </Text>
              {item.quote.text ? <Text type="body">{item.quote.text}</Text> : null}
              {item.quote.url ? (
                <Link
                  href={item.quote.url}
                  isExternalLink
                  isStandalone
                  onClick={onOpenUrl ? event => {
                    event.preventDefault();
                    onOpenUrl(item.quote!.url!, item);
                  } : undefined}
                >
                  Open quoted post
                </Link>
              ) : null}
              {item.quote.media?.length ? (
                <Grid columns={{minWidth: 80, repeat: 'fit'}} gap={2}>
                  {item.quote.media.map((media, index) => (
                    <LazyThumbnail
                      key={media.url + '-quote-' + index}
                      src={media.url}
                      alt={media.alt || 'Quoted post media ' + (index + 1)}
                      label={media.alt || 'Quoted post media ' + (index + 1)}
                      onClick={onMedia ? () => onMedia(media, item) : undefined}
                    />
                  ))}
                </Grid>
              ) : null}
            </VStack>
          </Section>
        ) : null}

        {mediaItems.length > 0 ? (
          <Grid columns={{minWidth: 80, repeat: 'fit'}} gap={2}>
            {mediaItems.map((media, index) => {
              const preview = media as PreviewMedia;
              // Every media type stores a displayable image in `url` (videos: the poster).
              const previewUrl = preview.thumbnailUrl || preview.previewUrl || media.url;
              const label = media.alt || `${media.type} preview ${index + 1}`;
              return (
                <LazyThumbnail
                  key={`${media.url}-${index}`}
                  src={previewUrl}
                  alt={media.alt || (previewUrl ? label : '')}
                  label={label}
                  onClick={onMedia ? () => onMedia(media, item) : undefined}
                />
              );
            })}
          </Grid>
        ) : null}

        <HStack gap={2} vAlign="center" wrap="wrap">
          {listLabel ? (
            onList ? (
              <Button label={listLabel} variant="ghost" size="sm" onClick={() => onList(item)} />
            ) : (
              <Text type="supporting" color="secondary">{listLabel}</Text>
            )
          ) : null}
          {item.tags?.map(tag => onTag ? (
            <Button
              key={tag}
              label={`#${tag}`}
              variant="ghost"
              size="sm"
              onClick={() => onTag(item, tag)}
            />
          ) : <Text key={tag} type="supporting" color="secondary">#{tag}</Text>)}
        </HStack>

        <HStack gap={2} vAlign="center" wrap="wrap">
          {url ? (
            <Link
              href={url}
              isExternalLink
              isStandalone
              onClick={onOpenUrl ? event => {
                event.preventDefault();
                onOpenUrl(url, item);
              } : undefined}
            >
              Open source
            </Link>
          ) : null}
          {onOpenDetails ? <Button label="Details" size="sm" onClick={() => onOpenDetails(item)} /> : null}
          {onCopy ? <Button label="Copy" variant="ghost" size="sm" icon={<Icon icon="copy" />} onClick={() => onCopy(item)} /> : null}
          {onDelete ? <Button label="Delete" variant="ghost" size="sm" onClick={() => onDelete(item)} /> : null}
        </HStack>
      </VStack>
    </Card>
  );
});
