import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { applySecurityMiddleware, StructuredLogger } from '@metrock/backend-common';
import { AppModule } from './app.module';

async function bootstrap() {
  // bufferLogs holds Nest's own bootstrap logs until useLogger below is
  // called, so even module-loading output comes out as structured JSON
  // instead of a few lines of the old plain-text format slipping through
  // first.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(new StructuredLogger('hr-service'));
  applySecurityMiddleware(app);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  const port = process.env.PORT ? Number(process.env.PORT) : 3007;
  await app.listen(port);
  new Logger('Bootstrap').log(`hr-service listening on :${port}`);
}
bootstrap();
