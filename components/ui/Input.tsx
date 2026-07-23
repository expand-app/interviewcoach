"use client";

import {
  forwardRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type ReactNode,
} from "react";

/**
 * Input + Textarea + Field — match the marketing site's `.field`
 * pattern exactly. All three render the same focus treatment (3px
 * shadow with text-color border) for consistent affordance.
 *
 * Use the <Field> wrapper for label + input pairing — it owns the
 * label styling, optional help text, and required/optional badges
 * so the form code reads as a flat list of fields rather than a
 * cascade of label/input/help divs.
 */

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref
) {
  return (
    <input
      ref={ref}
      className={"field-input" + (className ? " " + className : "")}
      {...rest}
    />
  );
});

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={"field-textarea" + (className ? " " + className : "")}
        {...rest}
      />
    );
  }
);

/**
 * Field — opinionated label + control + help wrapper.
 *
 * Required/optional badges sit right-aligned on the same row as the
 * label so the user can scan a form vertically and know at a glance
 * which fields are required without reading every label twice.
 */
interface FieldProps {
  label: string;
  htmlFor?: string;
  required?: boolean;
  optional?: boolean;
  /** Inline help text shown below the control. */
  help?: ReactNode;
  /** Inline error text shown below the control (replaces help when set). */
  error?: string;
  children: ReactNode;
  className?: string;
}

export function Field({
  label,
  htmlFor,
  required,
  optional,
  help,
  error,
  children,
  className,
}: FieldProps) {
  return (
    <div className={"mb-3 " + (className ?? "")}>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={htmlFor} className="field-label" style={{ marginBottom: 0 }}>
          {label}
        </label>
        {required && (
          <span className="text-[10.5px] font-medium tracking-wider uppercase text-text-subtle">
            Required
          </span>
        )}
        {!required && optional && (
          <span className="text-[10.5px] font-medium tracking-wider uppercase text-text-subtle">
            Optional
          </span>
        )}
      </div>
      {children}
      {error ? (
        <p className="field-help" style={{ color: "var(--color-error)" }}>
          {error}
        </p>
      ) : help ? (
        <div className="field-help">{help}</div>
      ) : null}
    </div>
  );
}
