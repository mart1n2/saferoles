/** One fixed icon for a contract. Which contract is shown by its name and address, never by the icon. */
export function ContractIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M5.5 2.5h6l3.5 3.5v10.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M11.5 2.5V6H15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M7 10h6M7 13h4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** One fixed icon for a role member (an account), never derived from its address. */
export function MemberIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="10" cy="7" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.8 16.5c.7-3 3.1-4.6 6.2-4.6s5.5 1.6 6.2 4.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
