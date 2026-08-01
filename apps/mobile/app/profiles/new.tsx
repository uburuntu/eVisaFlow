import type {
  AuthorityBasis,
  IdentityDocument,
  TwoFactorMethod,
} from "@evisa-flow/protocol";
import { router } from "expo-router";
import { UserPlus } from "lucide-react-native";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { AppButton } from "@/components/AppButton";
import { ChoiceGroup, ConfirmationRow, TextField } from "@/components/FormControls";
import { useAppTheme } from "@/theme";
import { ProfileLimitError, useVault } from "@/vault/VaultContext";

interface FormErrors {
  displayName?: string;
  documentNumber?: string;
  dateOfBirth?: string;
  confirmation?: string;
}

export default function NewProfileScreen() {
  const theme = useAppTheme();
  const vault = useVault();
  const [displayName, setDisplayName] = useState("");
  const [documentType, setDocumentType] = useState<IdentityDocument["type"]>("passport");
  const [documentNumber, setDocumentNumber] = useState("");
  const [day, setDay] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [twoFactorMethod, setTwoFactorMethod] = useState<TwoFactorMethod>("sms");
  const [authorityBasis, setAuthorityBasis] = useState<AuthorityBasis>("self");
  const [confirmed, setConfirmed] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);

  const saveProfile = async () => {
    const validation = validateForm({
      displayName,
      documentNumber,
      day,
      month,
      year,
      confirmed,
    });
    setErrors(validation.errors);
    if (!validation.dateOfBirth || Object.keys(validation.errors).length > 0) {
      return;
    }

    setSaving(true);
    try {
      await vault.addProfile({
        displayName,
        documentType,
        documentNumber,
        dateOfBirth: validation.dateOfBirth,
        preferredTwoFactorMethod: twoFactorMethod,
        authorityBasis,
      });
      router.replace("/");
    } catch (error) {
      if (error instanceof ProfileLimitError) {
        Alert.alert(
          "Family Pro required",
          "The free plan stores one person. Subscriptions are not connected in this build yet."
        );
      } else {
        Alert.alert("Could not save", "The profile could not be encrypted and saved.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[styles.page, { backgroundColor: theme.colors.background }]}
      testID="profile-form"
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.intro}>
          <Text style={[styles.title, { color: theme.colors.text }]}>Person details</Text>
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
            Stored only in the encrypted vault on this device.
          </Text>
        </View>

        <TextField
          autoCapitalize="words"
          autoComplete="name"
          error={errors.displayName}
          label="Name in this app"
          maxLength={60}
          onChangeText={setDisplayName}
          placeholder="For example, Sam"
          returnKeyType="next"
          testID="profile-name"
          value={displayName}
        />

        <ChoiceGroup
          choices={[
            { value: "passport", label: "Passport" },
            { value: "nationalId", label: "National ID" },
            { value: "brc", label: "Residence card" },
            { value: "ukvi", label: "UKVI number" },
          ]}
          label="Identity document"
          onChange={setDocumentType}
          testID="profile-document-type"
          value={documentType}
        />

        <TextField
          autoCapitalize="characters"
          autoCorrect={false}
          error={errors.documentNumber}
          label="Document number"
          maxLength={64}
          onChangeText={setDocumentNumber}
          placeholder="Enter without spaces"
          testID="profile-document-number"
          value={documentNumber}
        />

        <View style={styles.dateField}>
          <Text style={[styles.fieldLabel, { color: theme.colors.text }]}>
            Date of birth
          </Text>
          <View style={styles.dateRow}>
            <TextField
              containerStyle={styles.datePart}
              keyboardType="number-pad"
              label="Day"
              maxLength={2}
              onChangeText={setDay}
              placeholder="DD"
              testID="profile-birth-day"
              value={day}
            />
            <TextField
              containerStyle={styles.datePart}
              keyboardType="number-pad"
              label="Month"
              maxLength={2}
              onChangeText={setMonth}
              placeholder="MM"
              testID="profile-birth-month"
              value={month}
            />
            <TextField
              containerStyle={styles.dateYear}
              keyboardType="number-pad"
              label="Year"
              maxLength={4}
              onChangeText={setYear}
              placeholder="YYYY"
              testID="profile-birth-year"
              value={year}
            />
          </View>
          {errors.dateOfBirth ? (
            <Text style={[styles.error, { color: theme.colors.danger }]}>
              {errors.dateOfBirth}
            </Text>
          ) : null}
        </View>

        <ChoiceGroup
          choices={[
            { value: "sms", label: "Text message" },
            { value: "email", label: "Email" },
          ]}
          label="Preferred security code method"
          onChange={setTwoFactorMethod}
          testID="profile-two-factor"
          value={twoFactorMethod}
        />

        <ChoiceGroup
          choices={[
            { value: "self", label: "Myself" },
            { value: "parent_or_guardian", label: "Parent or guardian" },
            { value: "authorised_proxy", label: "Authorised by this person" },
          ]}
          label="Your authority"
          onChange={setAuthorityBasis}
          testID="profile-authority"
          value={authorityBasis}
        />

        <ConfirmationRow
          checked={confirmed}
          error={errors.confirmation}
          label="I confirm this relationship is accurate and I can access the account's security code."
          onChange={setConfirmed}
          testID="profile-authority-confirmation"
        />

        <AppButton
          icon={UserPlus}
          loading={saving}
          onPress={() => void saveProfile()}
          testID="profile-save"
          title="Save person"
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function validateForm(input: {
  displayName: string;
  documentNumber: string;
  day: string;
  month: string;
  year: string;
  confirmed: boolean;
}): { errors: FormErrors; dateOfBirth?: string } {
  const errors: FormErrors = {};

  if (input.displayName.trim().length === 0) {
    errors.displayName = "Enter a name.";
  }

  const normalizedDocumentNumber = input.documentNumber.replace(/\s/g, "");
  if (!/^[A-Za-z0-9-]{3,64}$/.test(normalizedDocumentNumber)) {
    errors.documentNumber = "Use 3-64 letters, numbers, or hyphens.";
  }

  const day = Number(input.day);
  const month = Number(input.month);
  const year = Number(input.year);
  const date = new Date(Date.UTC(year, month - 1, day));
  const validDate =
    /^\d{1,2}$/.test(input.day) &&
    /^\d{1,2}$/.test(input.month) &&
    /^\d{4}$/.test(input.year) &&
    year >= 1900 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getTime() <= Date.now();

  if (!validDate) {
    errors.dateOfBirth = "Enter a valid date of birth.";
  }

  if (!input.confirmed) {
    errors.confirmation = "Confirmation is required.";
  }

  if (!validDate) {
    return { errors };
  }

  return {
    errors,
    dateOfBirth: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 44,
    gap: 24,
  },
  intro: {
    gap: 5,
  },
  title: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "800",
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
  },
  dateField: {
    gap: 8,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: "700",
  },
  dateRow: {
    flexDirection: "row",
    gap: 9,
  },
  datePart: {
    flex: 1,
  },
  dateYear: {
    flex: 1.45,
  },
  error: {
    fontSize: 13,
    lineHeight: 18,
  },
});
