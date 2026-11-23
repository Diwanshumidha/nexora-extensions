import { Extension, s, tool, type Infer } from "@nexora/extension-sdk";

const GreetInput = s.object({ name: s.string("Who to greet") });
const AddInput = s.object({ a: s.number(), b: s.number() });

class Hello extends Extension {
  private greetings = 0;

  protected override onStart() {
    this.log.info(`hello extension started (data dir: ${this.dataDir})`);
  }

  @tool({ description: "Return a greeting for the given name", input: GreetInput, output: s.string(), readOnly: true })
  greet({ name }: Infer<typeof GreetInput>): string {
    this.greetings++;
    return `Hello, ${name}!`;
  }

  @tool({ description: "Add two numbers", input: AddInput, output: s.number(), readOnly: true })
  add({ a, b }: Infer<typeof AddInput>): number {
    return a + b;
  }

  @tool({ description: "How many greetings this session has produced", output: s.integer(), readOnly: true })
  stats(): number {
    return this.greetings;
  }
}

Hello.run();
