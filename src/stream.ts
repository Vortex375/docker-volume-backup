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
    return trim(Buffer.concat(this.chunks).toString('utf8'));
  }
}

export class WrappedStream extends Writable {

  constructor(private readonly spinner: Ora, private readonly destination: Writable) {
    super();
  }

  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.spinner.isSpinning) {
      this.spinner.stop();
      this.destination.write(chunk);
      this.spinner.start();
    } else {
      this.destination.write(chunk);
    }
    callback();
  }
}
