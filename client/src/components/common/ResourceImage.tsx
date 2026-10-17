import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { getResourceObjectUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ResourceImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> {
  resourceId: string;
}

/**
 * Image stored as a Joplin resource, loaded through the authenticated API.
 */
export function ResourceImage({ resourceId, alt, className, ...props }: ResourceImageProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    getResourceObjectUrl(resourceId)
      .then((objectUrl) => !cancelled && setUrl(objectUrl))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [resourceId]);

  if (failed) {
    return (
      <span className="inline-flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        <ImageOff className="h-4 w-4" />
        Image could not be loaded{alt ? `: ${alt}` : ""}
      </span>
    );
  }

  if (!url) {
    return (
      <span
        className="block h-40 w-full max-w-md animate-pulse rounded-lg bg-muted"
        role="img"
        aria-label={alt ? `Loading ${alt}` : "Loading image"}
      />
    );
  }

  return <img {...props} src={url} alt={alt ?? ""} className={cn(className)} />;
}
