# 아린이의 수유노트

Static web app (GitHub Pages) for a family's feeding log. Records live in a separate private repo
(`feeding-note-data`) reached with a token kept only on the phones — never put tokens or record data in this repo.

## Shipping a change
1. Edit `index.html` / `app.js`.
2. For any change the family will notice, add an entry at the top of `NEWS` in `app.js`
   (id = date `YYYY-MM-DD`, items tagged 추가 / 변경 / 고침, short plain Korean). Each phone shows unseen entries once.
3. Run `./bump.sh` (stamps the version so open phones reload to the new copy), commit, push to `main`.
4. Wait for the "pages build and deployment" run to succeed (`gh run list`); it occasionally times out and needs another push.
