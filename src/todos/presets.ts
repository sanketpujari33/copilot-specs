/**
 * Built-in preset templates for developer todos
 */
export interface TodoPreset {
  id: string;
  name: string;
  description: string;
  icon: string;
  config: {
    templates: Array<{
      id: string;
      name: string;
      description: string;
      applyTo?: string;
      fileContains?: string;
      excludeFileContains?: string;
      priority?: "high" | "medium" | "low";
      branchLevel?: boolean;
      aiInstruction?: string;
    }>;
  };
}

export const TODO_PRESETS: TodoPreset[] = [
  {
    id: "salesforce",
    name: "Salesforce Development",
    description: "Apex controllers, LWCs, Test Classes, Permission Sets, Triggers",
    icon: "⚡",
    config: {
      templates: [
        {
          id: "apex-permission",
          name: "Add Permission for the controller",
          description: "User needs permission to use the apex controller",
          applyTo: "force-app/main/default/classes/**/*.cls",
          fileContains: "@AuraEnabled",
          priority: "high",
          aiInstruction: "Create or update a permission set to grant access to this Apex class. Add the class to the 'Apex Class Access' section of the permission set.",
        },
        {
          id: "lwc-add-to-page",
          name: "Add LWC on a page",
          description: "The LWC needs to be added to a flexipage or similar to show up for the user",
          applyTo: "force-app/main/default/lwc/**",
          priority: "medium",
          aiInstruction: "Add the Lightning Web Component to a Lightning App Page (flexipage), Record Page, or Home Page using the Lightning App Builder.",
        },
        {
          id: "apex-test-class",
          name: "Create test class",
          description: "Add test coverage for the new Apex class",
          applyTo: "force-app/main/default/classes/**/*.cls",
          fileContains: "public class",
          excludeFileContains: "@isTest",
          priority: "high",
          aiInstruction: "Create a test class with @isTest annotation. Include test methods for all public methods. Aim for at least 75% code coverage. Use Test.startTest() and Test.stopTest().",
        },
        {
          id: "permission-set-to-group",
          name: "Add to permission set group",
          description: "New permission set should be added to a permission set group or assigned to users",
          applyTo: "force-app/main/default/permissionsets/**/*.permissionset-meta.xml",
          priority: "medium",
          aiInstruction: "Add this permission set to an existing permission set group, or assign it directly to users who need access to the functionality it grants.",
        },
        {
          id: "apex-trigger-framework",
          name: "Verify Apex Trigger Handler Pattern",
          description: "Ensure trigger logic uses handler pattern rather than inline business logic",
          applyTo: "force-app/main/default/triggers/**/*.trigger",
          priority: "medium",
          aiInstruction: "Delegate trigger execution logic to a dedicated TriggerHandler class to maintain clean separation of concerns.",
        },
      ],
    },
  },
  {
    id: "general-dev",
    name: "General Development (TS/JS/React)",
    description: "TypeScript, React components, API documentation, unit tests, state management",
    icon: "⚛️",
    config: {
      templates: [
        {
          id: "react-component-test",
          name: "Add React Component Unit Test",
          description: "Create tests using React Testing Library for the new component",
          applyTo: "src/components/**/*.tsx",
          excludeFileContains: ".test.",
          priority: "high",
          aiInstruction: "Create a test file matching *.test.tsx. Verify component rendering, prop handling, and user interactions with screen queries.",
        },
        {
          id: "api-endpoint-doc",
          name: "Add OpenAPI/Swagger Documentation",
          description: "Document new API endpoint routes",
          applyTo: "src/api/**/*.ts",
          fileContains: "router.",
          priority: "medium",
          aiInstruction: "Add OpenAPI JSDoc tags or schema annotations specifying parameter types, request body, and response status codes.",
        },
        {
          id: "storybook-story",
          name: "Create Storybook Story",
          description: "Add a Storybook story for UI visual testing",
          applyTo: "src/components/**/*.tsx",
          excludeFileContains: ".stories.",
          priority: "low",
          aiInstruction: "Create a *.stories.tsx file defining default and edge-case props for the component.",
        },
      ],
    },
  },
  {
    id: "python",
    name: "Python / Django / FastAPI",
    description: "pytest coverage, type hints, migrations, API schemas",
    icon: "🐍",
    config: {
      templates: [
        {
          id: "python-pytest",
          name: "Add Pytest Unit Test",
          description: "Write unit tests for new Python module",
          applyTo: "src/**/*.py",
          excludeFileContains: "test_",
          priority: "high",
          aiInstruction: "Create test_*.py in tests/ folder. Cover key paths and edge cases using pytest fixtures.",
        },
        {
          id: "django-migration",
          name: "Create Django DB Migration",
          description: "Run makemigrations when changing Django models",
          applyTo: "**/models.py",
          priority: "high",
          aiInstruction: "Run python manage.py makemigrations and verify generated migration files.",
        },
      ],
    },
  },
  {
    id: "go",
    name: "Go / Golang",
    description: "go test coverage, struct tags, error handling",
    icon: "🐹",
    config: {
      templates: [
        {
          id: "go-test",
          name: "Add Unit Test",
          description: "Create table-driven test for Go functions",
          applyTo: "**/*.go",
          excludeFileContains: "_test.go",
          priority: "high",
          aiInstruction: "Create *_test.go with table-driven tests testing input combinations.",
        },
      ],
    },
  },
  {
    id: "rust",
    name: "Rust",
    description: "unit tests, doc comments, Error traits",
    icon: "🦀",
    config: {
      templates: [
        {
          id: "rust-tests",
          name: "Add #[cfg(test)] Module",
          description: "Include unit test module for new Rust functions",
          applyTo: "src/**/*.rs",
          priority: "medium",
          aiInstruction: "Add inline #[cfg(test)] mod tests block with #[test] functions.",
        },
      ],
    },
  },
  {
    id: "java",
    name: "Java / Spring Boot",
    description: "JUnit 5 tests, OpenAPI docs, Spring beans",
    icon: "☕",
    config: {
      templates: [
        {
          id: "junit-test",
          name: "Add JUnit Test Class",
          description: "Create unit test with Mockito",
          applyTo: "src/main/java/**/*.java",
          excludeFileContains: "Test",
          priority: "high",
          aiInstruction: "Create matching Test class under src/test/java. Use @ExtendWith(MockitoExtension.class).",
        },
      ],
    },
  },
  {
    id: "csharp",
    name: "C# / .NET",
    description: "xUnit/NUnit tests, Async/Await patterns",
    icon: "🎯",
    config: {
      templates: [
        {
          id: "xunit-test",
          name: "Add xUnit Test Class",
          description: "Add unit tests for class logic",
          applyTo: "src/**/*.cs",
          excludeFileContains: "Tests.cs",
          priority: "high",
          aiInstruction: "Create matching Tests.cs file using [Fact] and [Theory] annotations.",
        },
      ],
    },
  },
  {
    id: "simple-starter",
    name: "Simple Starter",
    description: "Basic todo template structure to learn the extension",
    icon: "🚀",
    config: {
      templates: [
        {
          id: "unit-test",
          name: "Add Unit Tests",
          description: "Write unit tests for new file",
          applyTo: "**/*.ts",
          excludeFileContains: ".test.",
          priority: "high",
          aiInstruction: "Create matching .test.ts file testing exported functions.",
        },
        {
          id: "docs",
          name: "Update Documentation",
          description: "Document exported interfaces and methods",
          applyTo: "**/*.ts",
          priority: "low",
          aiInstruction: "Add JSDoc comments explaining parameters and return values.",
        },
      ],
    },
  },
];
