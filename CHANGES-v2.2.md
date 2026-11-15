# v2.2 — UX fixes (paste card, chhota details card, file + task)

1. **Lambi paste** (≥700 chars / ≥12 lines): input me chip ban jaati hai (textarea saaf rehta hai).
   Chat bubble me typed text + "PASTED" card; tap karo to poora text viewer me. Purani lambi messages
   bhi reload ke baad automatically card me collapse hoti hain.
2. **Repo/Vercel/Netlify/Render details card**: laptop (≥600px) pe chhota centered card (380px);
   phone pe wahi bottom-sheet.
3. **File/Folder/Zip + task**: pick karte hi tray me chip; ab turant repo nahi poochta.
   - khaali send  -> purana seedha upload flow
   - text files/paste + task -> content message ke saath /chat ko (chips bubble me)
   - zip/folder/binary + task -> ek card (repo + folder, naya repo ho to bana deta hai), upload, phir task chalta hai
   - .env files kabhi inline nahi jaati (sirf upload)
Backend: /chat ab optional `context.repo` leta hai; classifyMessage(message, seedRepo) me repo pehle se maana jaata hai.
Tests: tests/chain.test.ts me 4 naye test.
