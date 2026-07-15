interface LanternLogoProps {
  size?: number;
  className?: string;
}

export default function LanternLogo({ size = 32, className = "" }: LanternLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect x="1" y="1" width="62" height="62" rx="15" fill="#E5DECF" />
      <rect x="6" y="6" width="52" height="52" rx="12" fill="#FFFCF5" />
      <rect x="15" y="19" width="29" height="4" rx="2" fill="#B8B5AE" />
      <path
        d="M13.5 29.75C22.5 28.3 37.25 28.1 50.75 29.1L50.15 36.15C38.2 35.25 23.3 35.45 13.1 36.7L13.5 29.75Z"
        fill="#F7C968"
      />
      <rect x="15" y="31" width="34" height="4" rx="2" fill="#9D998F" />
      <path
        d="M23.5 38.4C31.7 37.45 42.5 39 51.1 37.95C54 37.6 56.25 36.7 57.75 34.75"
        stroke="#102746"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <rect x="15" y="44" width="26" height="4" rx="2" fill="#B8B5AE" />
    </svg>
  );
}
