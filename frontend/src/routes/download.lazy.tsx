// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createLazyFileRoute } from "@tanstack/react-router";
import { DownloadPage } from "@/components/download/DownloadPage";

/**
 * Desktop client download page. Like /login it is mounted under the root route (not in _app),
 * so it can be opened without logging in - it is a public landing page.
 *
 * It uses a lazy route: this page (page + hand-drawn preview SVG + its own CSS) is only needed by people who visit /download,
 * and a static import would weld it all into the main chunk, making login page and project page users pay for
 * download and parse cost for nothing.
 */
export const Route = createLazyFileRoute("/download")({
  component: DownloadPage,
});
