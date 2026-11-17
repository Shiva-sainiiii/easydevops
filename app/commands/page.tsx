import ContentPage, { pageMetadata } from "@/components/seo/ContentPage";
import { PAGES } from "@/lib/seo-content";

export const metadata = pageMetadata(PAGES["commands"]);

export default function Page() {
  return <ContentPage page={PAGES["commands"]} />;
}
