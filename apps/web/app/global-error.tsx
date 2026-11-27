"use client";

import { RouteErrorFallback, routeErrorTitle, type RouteErrorProps } from "./route-fallback";

export default function GlobalError(props: RouteErrorProps) {
  return (
    <html lang="ar" dir="rtl">
      <body style={{ margin: 0 }}>
        <title>{routeErrorTitle}</title>
        <RouteErrorFallback {...props} />
      </body>
    </html>
  );
}
