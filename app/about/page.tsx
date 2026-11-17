import ContentPage, { pageMetadata } from "@/components/seo/ContentPage";
import { PAGES } from "@/lib/seo-content";

export const metadata = pageMetadata(PAGES["about"]);

export default function Page() {
  return <ContentPage page={PAGES["about"]} />;
}
