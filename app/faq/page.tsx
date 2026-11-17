import ContentPage, { pageMetadata } from "@/components/seo/ContentPage";
import { PAGES } from "@/lib/seo-content";

export const metadata = pageMetadata(PAGES["faq"]);

export default function Page() {
  return <ContentPage page={PAGES["faq"]} />;
}
