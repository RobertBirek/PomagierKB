import swagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';

/**
 * OpenAPI: @fastify/swagger generuje spec z zadeklarowanych schematów tras;
 * dostęp wyłącznie dla roli admin przez GET /openapi.json (koperty nie stosujemy
 * — spec jest surowym dokumentem OpenAPI, analogicznie do downloadów).
 */
export async function registerSwagger(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'PomagierKB panel-api',
        description: 'REST API panelu baz wiedzy (koperta {ok,data}/{ok:false,error})',
        version: '1.0.0',
      },
      servers: [{ url: app.config.publicUrl }],
    },
  });

  app.get(
    '/openapi.json',
    {
      schema: { hide: true },
      config: { rbac: 'admin', audit: false, csrf: false },
    },
    async () => app.swagger(),
  );
}
