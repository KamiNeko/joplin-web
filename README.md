# Joplin Web

A modern, responsive, and lightweight web client for [Joplin Server](https://joplinapp.org/help/apps/sync/joplin_server/) and Joplin Cloud. Joplin Web allows you to browse, search, create, and edit your Joplin notes and notebooks from any modern web browser without requiring desktop or mobile client installations.

---

## Screenshot

```text
+-----------------------------------------------------------------------------------+
|  Joplin Web                                              [Search notes...]   (o)  |
+-------------------+-----------------------------+---------------------------------+
|  NOTEBOOKS        |  NOTES                      |  My First Note                  |
|  > Work           |  * Project Roadmap          |  ====================           |
|  v Personal       |    Updated 2h ago           |                                 |
|    - Reading List |                             |  This is a full-featured        |
|    - Travel Ideas |  * Book Recommendations     |  Markdown note editor with      |
|  > Archive        |    Updated yesterday        |  split preview and Joplin       |
|                   |                             |  server synchronization!        |
|  TAGS             |  * Grocery Checklist        |                                 |
|  #todo  #ideas    |    Updated 3 days ago       |  - [x] Check emails             |
|                   |                             |  - [ ] Deploy Joplin Web        |
+-------------------+-----------------------------+---------------------------------+
```
*(Placeholder: add screenshot to `docs/images/screenshot.png`)*

---

## Features

- **Direct Joplin Server Integration**: Connects with Joplin Server or Joplin Cloud sync APIs.
- **Notebook Tree Navigation**: Hierarchical notebook and sub-notebook browsing with folder management.
- **Full Note Management**: Create, view, edit, organize, and delete notes and to-dos.
- **Rich Markdown Editor**:
  - Live split-view or toggle preview.
  - GitHub Flavored Markdown (GFM) support (tables, task lists, formatting).
  - Code syntax highlighting.
  - Math expressions and diagram rendering.
- **Tag Management**: Assign tags to notes and browse notes filtered by tag.
- **Fast Search**: Instant full-text search across titles and note content.
- **Responsive & Modern UI**: Built with React, Vite, and modern styling, fully usable on desktop, tablet, and mobile browsers.
- **Single-Container Deployment**: Multi-stage lightweight Alpine Docker build serving both the Express API and compiled static React client on a single port.
- **Health Monitoring**: Integrated Docker health checks for production reliability.

---

## Tech Stack

### Frontend (`client/`)
- **Framework**: React 18
- **Language**: TypeScript
- **Build Tool**: Vite
- **Icons**: Lucide Icons
- **Markdown**: React Markdown with remark & rehype plugins

### Backend (`server/`)
- **Runtime**: Node.js 20+
- **Framework**: Express.js
- **Language**: TypeScript
- **API Communication**: Joplin Server REST & sync item endpoints
- **Static Hosting**: Express static file server serving compiled frontend assets in production

### DevOps & Infrastructure
- **Containerization**: Docker (multi-stage build based on `node:20-alpine`)
- **Orchestration**: Docker Compose

---

## Project Structure

```
joplin-web/
├── client/                   # Frontend React + Vite application
│   ├── src/                  # React components, hooks, contexts, and styles
│   ├── index.html            # Vite entry HTML
│   ├── package.json          # Frontend dependencies and scripts
│   ├── tsconfig.json         # Frontend TypeScript configuration
│   └── vite.config.ts        # Vite configuration & dev proxy
├── server/                   # Backend Express application
│   ├── src/                  # Express routes, Joplin client proxy, controllers
│   ├── package.json          # Backend dependencies and scripts
│   └── tsconfig.json         # Backend TypeScript configuration
├── docker/
│   └── Dockerfile            # Multi-stage production Docker build
├── .env.example              # Template for environment variables
├── .env                      # Local environment configuration (gitignored)
├── .gitignore                # Comprehensive Git ignore rules
├── docker-compose.yml        # Docker Compose deployment setup
├── LICENSE                   # MIT License
└── README.md                 # Project documentation
```

---

## Quick Start (Development)

### Prerequisites
- [Node.js](https://nodejs.org/) (version 20 or higher recommended)
- `npm` (version 9 or higher)

### 1. Configure Environment
Clone the repository and copy the environment template:
```bash
cp .env.example .env
```
Edit `.env` with your Joplin Server instance URL:
```env
JOPLIN_SERVER_URL=https://notes.your-domain.com
PORT=3001
CORS_ORIGIN=http://localhost:5173
NODE_ENV=development
```

### 2. Start the Backend Server
```bash
cd server
npm install
npm run dev
```
The backend API server will start on `http://localhost:3001`.

### 3. Start the Frontend Development Client
In a separate terminal window:
```bash
cd client
npm install
npm run dev
```
The frontend Vite server will start on `http://localhost:5173` with Hot Module Replacement (HMR).

---

## Docker Deployment

Joplin Web includes a multi-stage Dockerfile that compiles both the frontend and backend, serving everything from a single lightweight container.

### Using Docker Compose (Recommended)

1. Ensure `.env` is configured in the root directory.
2. Build and start the container:
   ```bash
   docker compose up -d --build
   ```
3. Check container status:
   ```bash
   docker compose ps
   ```
4. Access Joplin Web in your browser at `http://localhost:3001`.

To stop the service:
```bash
docker compose down
```

### Using Plain Docker

1. Build the production image:
   ```bash
   docker build -t joplin-web -f docker/Dockerfile .
   ```
2. Run the container:
   ```bash
   docker run -d \
     --name joplin-web \
     -p 3001:3001 \
     -e JOPLIN_SERVER_URL=https://notes.your-domain.com \
     -e PORT=3001 \
     -e NODE_ENV=production \
     --restart unless-stopped \
     joplin-web
   ```

---

## Environment Variables

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `JOPLIN_SERVER_URL` | **Yes** | — | Base URL of your Joplin Server or Joplin Cloud instance (e.g., `https://notes.example.com`). |
| `PORT` | No | `3001` | Network port for the Express application server. |
| `CORS_ORIGIN` | No | `http://localhost:5173` | Allowed origin for Cross-Origin Resource Sharing during development. |
| `NODE_ENV` | No | `development` | Runtime mode: `development` or `production`. In production, static assets from `client/dist` are served directly. |

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
