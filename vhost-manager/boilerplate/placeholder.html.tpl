<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1" />
    <meta
      name="robots"
      content="noindex, nofollow" />
    <meta
      name="color-scheme"
      content="light dark" />
    <title>{{SITE_TITLE}}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: system-ui, sans-serif;
        background: #f4f7f6;
        color: #26332b;
      }
      body {
        min-height: 100vh;
        box-sizing: border-box;
        display: grid;
        place-items: center;
        margin: 0;
        padding: 2rem;
      }
      main {
        width: min(100%, 42rem);
        padding: clamp(1.5rem, 5vw, 3rem);
        border: 1px solid #d8e1dc;
        border-radius: 1rem;
        background: #fff;
        box-shadow: 0 1rem 3rem #17282012;
      }
      h1 {
        margin: 0 0 1rem;
        font-size: clamp(2rem, 7vw, 3.5rem);
        line-height: 1.1;
        overflow-wrap: anywhere;
      }
      p {
        margin: 0;
        color: #52635a;
        font-size: 1.125rem;
        line-height: 1.6;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          background: #242424;
          color: #f0f4f2;
        }
        main {
          border-color: #505050;
          background: #303030;
          box-shadow: none;
        }
        p {
          color: #c5cfca;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>{{SITE_TITLE}}</h1>
      <p>This website is set up and ready for your content.</p>
    </main>
  </body>
</html>
