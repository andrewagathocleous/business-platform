import { Injectable } from '@nestjs/common';

export type Clock = {
  now(): Date;
};

export const CLOCK = Symbol('CLOCK');

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export function clockNow(clock: Clock): Date {
  return new Date(clock.now().getTime());
}
