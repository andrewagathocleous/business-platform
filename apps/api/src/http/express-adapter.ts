import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';

/**
 * The Express router copies `case sensitive routing` when it is first created.
 * Nest creates that router inside the adapter constructor, so the flag has to
 * be set on the Express instance before the adapter is constructed.
 */
export function caseSensitiveAdapter(): ExpressAdapter {
  const server = express();
  server.set('case sensitive routing', true);
  // Repeated filters such as fulfilmentStatus[]=new&fulfilmentStatus[]=preparing.
  // Express 5's simple parser keeps only the last value.
  server.set('query parser', 'extended');
  return new ExpressAdapter(server);
}
