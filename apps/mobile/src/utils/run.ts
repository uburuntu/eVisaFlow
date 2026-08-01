import type { Purpose } from "@evisa-flow/protocol";
import { BriefcaseBusiness, House, type LucideIcon, Shapes } from "lucide-react-native";

export interface PurposeOption {
  value: Purpose;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const purposeOptions: PurposeOption[] = [
  {
    value: "right_to_work",
    label: "Right to work",
    description: "For an employer or recruiter",
    icon: BriefcaseBusiness,
  },
  {
    value: "right_to_rent",
    label: "Right to rent",
    description: "For a landlord or letting agent",
    icon: House,
  },
  {
    value: "immigration_status_other",
    label: "Something else",
    description: "For another immigration status check",
    icon: Shapes,
  },
];

export const purposeLabels: Record<Purpose, string> = {
  right_to_work: "Right to work",
  right_to_rent: "Right to rent",
  immigration_status_other: "Other status check",
};
