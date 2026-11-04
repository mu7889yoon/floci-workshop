# Floci Workshop Marp deck

The deck uses the supplied `mu7889yoon` Marp theme. The CSS is copied into this directory so the source can be rendered without fetching the theme at presentation time.

Render from this directory with Marp CLI:

```bash
npx --yes @marp-team/marp-cli --theme-set ./mu7889yoon-theme.css ./floci-workshop.md --pdf --output ./floci-workshop.pdf
```

The PDF is a static talk deck. The live attendee editor, Bash terminal, join button, and MicroVM lifecycle remain on the deployed workshop page.
