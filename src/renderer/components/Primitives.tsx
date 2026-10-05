import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
export function Button({ children, icon, onClick, disabled = false, variant = '', title, type = 'button' }: {
    children: ReactNode;
    icon?: string;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    title?: string;
    type?: 'button' | 'submit';
}) { return <button type={type} className={`button ${variant}`} onClick={onClick} disabled={disabled} title={title}>{icon && <Icon name={icon}/>} {children}</button>; }
export function Badge({ children, tone = '' }: {
    children: ReactNode;
    tone?: string;
}) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Panel({ children, title, sub, actions, className = '' }: {
    children: ReactNode;
    title?: string;
    sub?: string;
    actions?: ReactNode;
    className?: string;
}) { return <section className={`panel ${className}`}>{title && <div className="panel-heading"><div><h2>{title}</h2>{sub && <p>{sub}</p>}</div>{actions}</div>}{children}</section>; }
export function Empty({ title, detail, children, icon = 'folder' }: {
    title: string;
    detail: string;
    children?: ReactNode;
    icon?: string;
}) { return <div className="empty"><Icon name={icon} size={32}/><h3>{title}</h3><p>{detail}</p>{children}</div>; }
export function Field({ label, children, hint }: {
    label: string;
    children: ReactNode;
    hint?: string;
}) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Modal({ title, children, onClose }: {
    title: string;
    children: ReactNode;
    onClose: () => void;
}) { const ref = useRef<HTMLDivElement>(null); const close = useRef(onClose); close.current = onClose; useEffect(() => { const old = document.activeElement as HTMLElement | null; const node = ref.current; node?.querySelector<HTMLElement>('button,input,select')?.focus(); const listener = (e: KeyboardEvent) => { if (e.key === 'Escape')
    close.current(); if (e.key === 'Tab') {
    const all = node?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select,textarea,a[href]');
    if (!all?.length)
        return;
    const first = all[0], last = all[all.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    }
    else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
} }; document.addEventListener('keydown', listener); return () => { document.removeEventListener('keydown', listener); old?.focus(); }; }, []); return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget)
    onClose(); }}><div className="modal" ref={ref} role="dialog" aria-modal="true" aria-label={title}><div className="panel-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><Icon name="close"/></button></div>{children}</div></div>; }
export const time = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`;
