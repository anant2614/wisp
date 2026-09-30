import http from 'node:http';
import { World } from './world';
import { scenarios } from './scenarios';

const port = Number(process.env.FIXTURE_PORT ?? 4010);
const world = new World(`http://127.0.0.1:${port}`);
world.model.add(...scenarios);

http
  .createServer((req, res) => {
    world.handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e));
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`fixture world on :${port}`));
