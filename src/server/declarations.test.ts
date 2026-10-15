import { describe, expect, it } from 'vitest';
import { declares } from './declarations.js';

describe('declares', () => {
    it.each([
        ['export class Foo extends Bar {', 'Foo'],
        ['export default abstract class Foo {', 'Foo'],
        ['interface Foo<T> {', 'Foo'],
        ['export type Foo = Bar | Baz;', 'Foo'],
        ['enum Foo {', 'Foo'],
        ['export async function foo(x: number) {', 'foo'],
        ['function* foo() {', 'foo'],
        ['export const foo = async (x: number) => {', 'foo'],
        ['    async def foo(self):', 'foo'],
        ['class Foo(Base):', 'Foo'],
        ['pub(crate) fn foo(x: u32) -> u32 {', 'foo'],
        ['type Foo struct {', 'Foo'],
        ['func (r *Repo) Foo(ctx context.Context) error {', 'Foo'],
        ['    public static Task<Foo> foo(int x)', 'foo'],
        ['    private readonly store: Store;', 'store'],
        ['    async reviewSearch(round: number | undefined, query: string): Promise<SearchResult> {', 'reviewSearch'],
        ['int main(void) {', 'main'],
        ['$foo() {', '$foo']
    ])('finds %j declaring %s', (line, name) => {
        expect(declares(line, name)).toBe(true);
    });

    it.each([
        ['export class Foo extends Bar {', 'Bar'],
        ['import { Foo } from "./foo";', 'Foo'],
        ['const x: Foo = new Foo();', 'Foo'],
        ['    private store: Store = new Store();', 'Store'],
        ['    foo(x);', 'foo'],
        ['useEffect(() => {', 'useEffect'],
        ["it('does it', () => {", 'it'],
        ["describe('it', function () {", 'describe'],
        ['if foo(x) {', 'foo'],
        ['for x in foo(y) {', 'foo'],
        ['} else if (foo(x)) {', 'foo'],
        ['    foo: 1,', 'foo'],
        ['class FooBar {', 'Foo'],
        [`const foo = 1; ${'x'.repeat(400)}`, 'foo']
    ])('does not take %j as declaring %s', (line, name) => {
        expect(declares(line, name)).toBe(false);
    });
});
