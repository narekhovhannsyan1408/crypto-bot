import { HttpException } from '@nestjs/common';
import { Msg, renderMsg } from './messages';

/**
 * Ошибка API с переводимым сообщением: message — английский текст для клиентов API,
 * i18n — ключ словаря, по которому страница покажет текст на выбранном языке.
 */
export const localizedHttpError = (status: number, message: Msg) =>
  new HttpException(
    { statusCode: status, message: renderMsg('en', message), i18n: message },
    status,
  );
