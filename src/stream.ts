import { trim } from 'lodash';
import { Ora } from 'ora';
import { Writable } from 'stream';

export class ToStringStream extends Writable {
  private readonly chunks: Buffer[] = [];

  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(chunk);
    callback();
  }

  isEmpty() {
    return this.chunks.length === 0 || trim(Buffer.concat(this.chunks).toString('utf8')).length === 0;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

export class WrappedStdoutStream extends Writable {

  constructor(private readonly spinner: Ora) {
    super();
  }

  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.spinner.isSpinning) {
      this.spinner.stop();
      process.stdout.write(chunk);
      this.spinner.start();
    } else {
      process.stdout.write(chunk);
    }
    callback();
  }
}
