import { FieldChrome } from "@/components/field/chrome";

export const metadata = { title: "Field" };

export default function Layout({ children }: LayoutProps<"/field">) {
  return <FieldChrome>{children}</FieldChrome>;
}
