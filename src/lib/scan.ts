export type ScanKind =
  | 'url'
  | 'email'
  | 'phone'
  | 'wifi'
  | 'upi'
  | 'vcard'
  | 'geo'
  | 'calendar'
  | 'isbn'
  | 'barcode'
  | 'image'
  | 'or-transfer'
  | 'text';

export type ScanAnalysis = {
  kind: ScanKind;
  title: string;
  subtitle: string;
  value: string;
  actionLabel?: string;
  actionUrl?: string;
  meta: Record<string, string>;
};

function clean(value: string) {
  return value.trim();
}

function decodePart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function analyzeScan(value: string, format = ''): ScanAnalysis {
  const raw = clean(value);
  const upper = raw.toUpperCase();
  const normalizedFormat = format.toLowerCase();

  if (raw.startsWith('ORIMG1:data:image/')) return { kind: 'image', title: 'Image QR', subtitle: 'A photo is embedded in this QR code.', value: raw, meta: { Type: 'Compressed image', Storage: 'Inside QR code' } };

  if (upper.startsWith('ORX1:') || upper.startsWith('ORX2:')) {
    const parts = raw.split('|');
    const session = parts[0].slice(5);
    const size = Number(parts[3]);
    const total = Number(parts[6]);
    const index = Number(parts[5]);
    return {
      kind: 'or-transfer',
      title: 'OR Transfer frame',
      subtitle: session ? 'Offline file-transfer frame' : 'Offline transfer frame',
      value: raw,
      actionLabel: 'Open OR Transfer',
      actionUrl: '#/transfer',
      meta: {
        Session: session || 'Unknown',
        ...(Number.isFinite(size) ? { Size: `${(size / 1024 / 1024).toFixed(2)} MB` } : {}),
        ...(Number.isInteger(index) && Number.isInteger(total) ? { Frame: `${index} / ${total}` } : {}),
      },
    };
  }

  if (upper.startsWith('WIFI:')) {
    const body = raw.slice(5);
    const fields: Record<string, string> = {};
    body.split(';').forEach((part) => {
      const separator = part.indexOf(':');
      if (separator > 0) fields[part.slice(0, separator)] = decodePart(part.slice(separator + 1));
    });
    return {
      kind: 'wifi',
      title: 'Wi-Fi network',
      subtitle: fields.S || 'Wireless network',
      value: raw,
      meta: {
        Network: fields.S || 'Hidden / unavailable',
        Security: fields.T || 'Unknown',
        Password: fields.P ? 'Available' : 'Not included',
      },
    };
  }

  if (upper.startsWith('UPI://')) {
    try {
      const url = new URL(raw);
      return {
        kind: 'upi',
        title: 'UPI payment',
        subtitle: url.searchParams.get('pn') || url.searchParams.get('pa') || 'Payment information',
        value: raw,
        actionLabel: 'Open UPI',
        actionUrl: raw,
        meta: {
          Payee: url.searchParams.get('pn') || 'Not specified',
          'UPI ID': url.searchParams.get('pa') || 'Not specified',
          Amount: url.searchParams.get('am') || 'Not specified',
        },
      };
    } catch {
      return { kind: 'upi', title: 'UPI payment', subtitle: 'Payment information', value: raw, meta: {} };
    }
  }

  if (upper.startsWith('BEGIN:VCARD')) {
    const name = raw.match(/^FN:(.+)$/m)?.[1]?.trim() || 'Contact';
    const phone = raw.match(/^TEL[^:]*:(.+)$/m)?.[1]?.trim();
    const email = raw.match(/^EMAIL[^:]*:(.+)$/m)?.[1]?.trim();
    return {
      kind: 'vcard',
      title: 'Contact card',
      subtitle: name,
      value: raw,
      meta: { Name: name, ...(phone ? { Phone: phone } : {}), ...(email ? { Email: email } : {}) },
    };
  }

  if (upper.startsWith('GEO:')) {
    const coords = raw.slice(4).split(/[;,]/);
    return {
      kind: 'geo',
      title: 'Location',
      subtitle: coords.slice(0, 2).join(', '),
      value: raw,
      actionLabel: 'Open Maps',
      actionUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coords.slice(0, 2).join(','))}`,
      meta: { Latitude: coords[0] || 'Unknown', Longitude: coords[1] || 'Unknown' },
    };
  }

  if (upper.startsWith('BEGIN:VEVENT')) {
    const summary = raw.match(/^SUMMARY:(.+)$/m)?.[1]?.trim() || 'Calendar event';
    return { kind: 'calendar', title: 'Calendar event', subtitle: summary, value: raw, meta: {} };
  }

  if (/^(?:ISBN(?:-1[03])?:?\s*)?(97[89])\d{10}$/.test(raw.replace(/[-\s]/g, ''))) {
    const isbn = raw.replace(/[-\s]/g, '');
    return {
      kind: 'isbn',
      title: 'ISBN',
      subtitle: isbn,
      value: raw,
      actionLabel: 'Search book',
      actionUrl: `https://www.google.com/search?q=${encodeURIComponent(isbn)}`,
      meta: { ISBN: isbn },
    };
  }

  if (/^(?:EAN|UPC|CODE|ITF|CODABAR|DATA MATRIX|PDF417|AZTEC)/i.test(normalizedFormat) || /^(?:\d{8}|\d{12,14})$/.test(raw)) {
    return {
      kind: 'barcode',
      title: normalizedFormat ? `${format} barcode` : 'Barcode',
      subtitle: raw,
      value: raw,
      actionLabel: 'Search barcode',
      actionUrl: `https://www.google.com/search?q=${encodeURIComponent(raw)}`,
      meta: { Format: format || 'Barcode', Value: raw },
    };
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return {
        kind: 'url',
        title: 'Website',
        subtitle: url.hostname,
        value: raw,
        actionLabel: 'Open website',
        actionUrl: raw,
        meta: { Domain: url.hostname, Protocol: url.protocol.replace(':', '').toUpperCase() },
      };
    } catch {
      // Continue to generic text.
    }
  }

  if (/^mailto:/i.test(raw) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    const email = raw.replace(/^mailto:/i, '');
    return {
      kind: 'email',
      title: 'Email address',
      subtitle: email,
      value: raw,
      actionLabel: 'Send email',
      actionUrl: `mailto:${email}`,
      meta: { Email: email },
    };
  }

  if (/^tel:/i.test(raw) || /^\+?[\d\s().-]{7,}$/.test(raw)) {
    const phone = raw.replace(/^tel:/i, '');
    return {
      kind: 'phone',
      title: 'Phone number',
      subtitle: phone,
      value: raw,
      actionLabel: 'Call',
      actionUrl: `tel:${phone.replace(/[^+\d]/g, '')}`,
      meta: { Phone: phone },
    };
  }

  return {
    kind: 'text',
    title: 'Text',
    subtitle: raw.length > 70 ? `${raw.slice(0, 67)}…` : raw,
    value: raw,
    meta: { Characters: String(raw.length) },
  };
}
