import { write } from '@/lib/api';
import { importCsv } from '@/lib/csv-kml';
import { ValidationError } from '@/lib/events';

export const dynamic = 'force-dynamic';

export const POST = write(async (req) => {
  const form = await req.formData();
  const f = form.get('file');
  if (!(f instanceof File)) throw new ValidationError('CSV 파일을 선택하세요');
  const text = await f.text();
  return importCsv(text);
});
