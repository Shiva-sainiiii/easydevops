import ScriptLoader from "@/components/ScriptLoader";
import { APP_MARKUP } from "@/components/app-markup";

// `display: contents` wrapper layout me kuch add nahi karta — #ambient / #app waise hi <body> ke direct children jaise behave karte hain.
export default function Page() {
  return (
    <>
      <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: APP_MARKUP }} />
      <ScriptLoader />
    </>
  );
}
