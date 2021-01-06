# Pinto
## Node Express server for Peer to Peer connections.

### Prerequisites

This project is managed through something called a **package**. A package contains all the code being shared as well as a `package.json` file (called a **manifest**) which describes the package.

This project requires:

* Node `15.x` installed, if unfamiliar learn more about Nodejs by visting [here](https://nodejs.org).
* NPM comes with node installation and will be used to manage packages.
* Optionally, you can use Yarn to manage dependencies instead.
* To deploy you'll want to install **Heroku CLI** choosing one of these [CLI Installers](https://devcenter.heroku.com/articles/heroku-cli).

On a Mac, you can obtain all of the above packages using [Homebrew](http://brew.sh).

## Getting Started

First, install the latest packages by running:

```bash
npm install
# or
yarn install
```

Start your development server:

```bash
npm run dev
# or
yarn dev
```

To locally start all of the process types that are defined in your Procfile:

```
heroku local
```

Open [http://localhost:5000](http://localhost:5000) with your browser to see the result.

You can modify the Signal Server by opening `src/index.ts`. `Nodemon` will auto restart your development server for you as you make changes to files within the `src` directory.
