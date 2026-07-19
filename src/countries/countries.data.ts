export interface CountryDef {
  code: string; // ISO 3166-1 alpha-2, also the Apple Music storefront (lowercased)
  name: string;
  flag: string;
}

export const COUNTRIES: CountryDef[] = [
  { code: 'US', name: 'États-Unis',      flag: '🇺🇸' },
  { code: 'GB', name: 'Royaume-Uni',     flag: '🇬🇧' },
  { code: 'FR', name: 'France',          flag: '🇫🇷' },
  { code: 'DE', name: 'Allemagne',       flag: '🇩🇪' },
  { code: 'ES', name: 'Espagne',         flag: '🇪🇸' },
  { code: 'IT', name: 'Italie',          flag: '🇮🇹' },
  { code: 'PT', name: 'Portugal',        flag: '🇵🇹' },
  { code: 'NL', name: 'Pays-Bas',        flag: '🇳🇱' },
  { code: 'BE', name: 'Belgique',        flag: '🇧🇪' },
  { code: 'CH', name: 'Suisse',          flag: '🇨🇭' },
  { code: 'AT', name: 'Autriche',        flag: '🇦🇹' },
  { code: 'IE', name: 'Irlande',         flag: '🇮🇪' },
  { code: 'SE', name: 'Suède',           flag: '🇸🇪' },
  { code: 'NO', name: 'Norvège',         flag: '🇳🇴' },
  { code: 'DK', name: 'Danemark',        flag: '🇩🇰' },
  { code: 'FI', name: 'Finlande',        flag: '🇫🇮' },
  { code: 'PL', name: 'Pologne',         flag: '🇵🇱' },
  { code: 'CA', name: 'Canada',          flag: '🇨🇦' },
  { code: 'MX', name: 'Mexique',         flag: '🇲🇽' },
  { code: 'BR', name: 'Brésil',          flag: '🇧🇷' },
  { code: 'AR', name: 'Argentine',       flag: '🇦🇷' },
  { code: 'CL', name: 'Chili',           flag: '🇨🇱' },
  { code: 'CO', name: 'Colombie',        flag: '🇨🇴' },
  { code: 'AU', name: 'Australie',       flag: '🇦🇺' },
  { code: 'NZ', name: 'Nouvelle-Zélande', flag: '🇳🇿' },
  { code: 'JP', name: 'Japon',           flag: '🇯🇵' },
  { code: 'KR', name: 'Corée du Sud',    flag: '🇰🇷' },
  { code: 'IN', name: 'Inde',            flag: '🇮🇳' },
  { code: 'ID', name: 'Indonésie',       flag: '🇮🇩' },
  { code: 'TR', name: 'Turquie',         flag: '🇹🇷' },
  { code: 'SA', name: 'Arabie saoudite', flag: '🇸🇦' },
  { code: 'AE', name: 'Émirats arabes unis', flag: '🇦🇪' },
];

export const COUNTRY_CODES = COUNTRIES.map(c => c.code);

export function findCountry(code: string): CountryDef | undefined {
  return COUNTRIES.find(c => c.code === code.toUpperCase());
}
