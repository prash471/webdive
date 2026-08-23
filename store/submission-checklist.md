# Chrome Web Store submission checklist

## Already prepared

- [x] Manifest V3
- [x] Single required permission: `debugger`
- [x] 16, 32, 48, and 128 px extension icons
- [x] Local-only architecture and prominent in-product disclosure
- [x] Public privacy policy with Limited Use disclosure
- [x] Store name, descriptions, and permission justification
- [x] 1280×800 illustrative screenshot and 440×280 small promotional tile
- [x] Runtime-only ZIP package

## Developer Dashboard steps

- [ ] Register and verify a Chrome Web Store developer account.
- [ ] Host the static product and privacy pages on a stable HTTPS site such as GitHub Pages.
- [ ] Create a new item and upload `dist/webdive-0.5.0.zip`.
- [ ] Select the Developer Tools category and English as the primary language.
- [ ] Paste the content from `store/listing.md`.
- [ ] Enter the hosted product homepage and privacy-policy URLs.
- [ ] Complete the Privacy practices questionnaire consistently with `privacy.html`.
- [ ] Upload `store/assets/screenshot-overview.png` and `store/assets/small-promo.png`. Replace or supplement the illustrative screenshot with a real product capture if desired; do not expose confidential application URLs or source code.
- [ ] Choose distribution regions and visibility.
- [ ] Submit for review after checking the preview and permission warning.

## Privacy questionnaire notes

WebDive locally handles website content and web browsing activity as necessary for its single user-facing purpose. It does not collect this data to a developer server, sell it, use it for advertising, or permit human access. Answer dashboard questions according to Google’s exact wording and the behavior of the version being submitted.
