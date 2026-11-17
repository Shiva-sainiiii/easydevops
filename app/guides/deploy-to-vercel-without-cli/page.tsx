import ContentPage, { pageMetadata } from "@/components/seo/ContentPage";
import { PAGES } from "@/lib/seo-content";

const page = PAGES["guides/deploy-to-vercel-without-cli"];

export const metadata = pageMetadata(page);

export default function Page() {
  return <ContentPage page={page} />;
}
