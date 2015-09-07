import * as ts from "typescript";

import {Context} from "../Context";
import {Converter} from "../Converter";
import {ReflectionKind, ReflectionFlag, ITypeParameterContainer} from "../../models/Reflection";
import {DeclarationReflection} from "../../models/reflections/DeclarationReflection";
import {ContainerReflection} from "../../models/reflections/ContainerReflection";
import {ReferenceType} from "../../models/types/ReferenceType";
import {SignatureReflection} from "../../models/reflections/SignatureReflection";
import {Type} from "../../models/Type";
import {getDefaultValue} from "./convertNode";
import {convertType, convertDestructuringType} from "./convertType";
import {ParameterReflection} from "../../models/reflections/ParameterReflection";
import {TypeParameterType} from "../../models/types/TypeParameterType";
import {TypeParameterReflection} from "../../models/reflections/TypeParameterReflection";


/**
 * List of reflection kinds that never should be static.
 */
var nonStaticKinds = [
    ReflectionKind.Class,
    ReflectionKind.Interface,
    ReflectionKind.Module
];

/**
 * Create a declaration reflection from the given TypeScript node.
 *
 * @param context  The context object describing the current state the converter is in. The
 *   scope of the context will be the parent of the generated reflection.
 * @param node  The TypeScript node that should be converted to a reflection.
 * @param kind  The desired kind of the reflection.
 * @param name  The desired name of the reflection.
 * @returns The resulting reflection.
 */
export function createDeclaration(context:Context, node:ts.Node, kind:ReflectionKind, name?:string):DeclarationReflection {
    var container = <ContainerReflection>context.scope;
    if (!(container instanceof ContainerReflection)) {
        throw new Error('Expected container reflection.');
    }

    // Ensure we have a name for the reflection
    if (!name) {
        if (!node.symbol) return null;
        name = node.symbol.name;
    }

    // Test whether the node is exported
    var isExported = container.kindOf(ReflectionKind.Module) ? false : container.flags.isExported;
    if (node.parent && node.parent.kind == ts.SyntaxKind.VariableDeclarationList) {
        isExported = isExported || !!(node.parent.parent.flags & ts.NodeFlags.Export)
    } else {
        isExported = isExported || !!(node.flags & ts.NodeFlags.Export);
    }

    if (!isExported && context.getOptions().excludeNotExported) {
        return null;
    }

    // Test whether the node is private, when inheriting ignore private members
    var isPrivate = !!(node.flags & ts.NodeFlags.Private);
    if (context.isInherit && isPrivate) {
        return null;
    }

    // Test whether the node is static, when merging a module to a class make the node static
    var isConstructorProperty:boolean = false;
    var isStatic = false;
    if (nonStaticKinds.indexOf(kind) == -1) {
        isStatic = !!(node.flags & ts.NodeFlags.Static);
        if (container.kind == ReflectionKind.Class) {
            if (node.parent && node.parent.kind == ts.SyntaxKind.Constructor) {
                isConstructorProperty = true;
            } else if (!node.parent || node.parent.kind != ts.SyntaxKind.ClassDeclaration) {
                isStatic = true;
            }
        }
    }

    // Check if we already have a child with the same name and static flag
    var child:DeclarationReflection;
    var children = container.children = container.children || [];
    children.forEach((n) => {
        if (n.name == name && n.flags.isStatic == isStatic) child = n;
    });

    if (!child) {
        // Child does not exist, create a new reflection
        child = new DeclarationReflection(container, name, kind);
        child.setFlag(ReflectionFlag.Static, isStatic);
        child.setFlag(ReflectionFlag.Private, isPrivate);
        child.setFlag(ReflectionFlag.ConstructorProperty, isConstructorProperty);
        child.setFlag(ReflectionFlag.Exported,  isExported);
        child = setupDeclaration(context, child, node);

        if (child) {
            children.push(child);
            context.registerReflection(child, node);
        }
    } else {
        // Merge the existent reflection with the given node
        child = mergeDeclarations(context, child, node, kind);
    }

    // If we have a reflection, trigger the corresponding event
    if (child) {
        context.trigger(Converter.EVENT_CREATE_DECLARATION, child, node);
    }

    return child;
}


/**
 * Setup a newly created declaration reflection.
 *
 * @param context  The context object describing the current state the converter is in.
 * @param reflection  The newly created blank reflection.
 * @param node  The TypeScript node whose properties should be applies to the given reflection.
 * @returns The reflection populated with the values of the given node.
 */
function setupDeclaration(context:Context, reflection:DeclarationReflection, node:ts.Node) {
    reflection.setFlag(ReflectionFlag.External,  context.isExternal);
    reflection.setFlag(ReflectionFlag.Protected, !!(node.flags & ts.NodeFlags.Protected));
    reflection.setFlag(ReflectionFlag.Public,    !!(node.flags & ts.NodeFlags.Public));
    reflection.setFlag(ReflectionFlag.Optional,  !!(node['questionToken']));

    if (
        context.isInherit &&
        (node.parent == context.inheritParent || reflection.flags.isConstructorProperty)
    ) {
        if (!reflection.inheritedFrom) {
            reflection.inheritedFrom = createReferenceType(context, node.symbol, true);
            reflection.getAllSignatures().forEach((signature) => {
                signature.inheritedFrom = createReferenceType(context, node.symbol, true);
            });
        }
    }

    return reflection;
}


/**
 * Merge the properties of the given TypeScript node with the pre existent reflection.
 *
 * @param context  The context object describing the current state the converter is in.
 * @param reflection  The pre existent reflection.
 * @param node  The TypeScript node whose properties should be merged with the given reflection.
 * @param kind  The desired kind of the reflection.
 * @returns The reflection merged with the values of the given node or NULL if the merge is invalid.
 */
function mergeDeclarations(context:Context, reflection:DeclarationReflection, node:ts.Node, kind:ReflectionKind) {
    if (reflection.kind != kind) {
        var weights = [ReflectionKind.Module, ReflectionKind.Enum, ReflectionKind.Class];
        var kindWeight = weights.indexOf(kind);
        var childKindWeight = weights.indexOf(reflection.kind);
        if (kindWeight > childKindWeight) {
            reflection.kind = kind;
        }
    }

    if (
        context.isInherit &&
        context.inherited.indexOf(reflection.name) != -1 &&
        (node.parent == context.inheritParent || reflection.flags.isConstructorProperty)
    ) {
        if (!reflection.overwrites) {
            reflection.overwrites = createReferenceType(context, node.symbol, true);
            reflection.getAllSignatures().forEach((signature) => {
                signature.overwrites = createReferenceType(context, node.symbol, true);
            });
        }
        return null;
    }

    return reflection;
}


/**
 * Create a new reference type pointing to the given symbol.
 *
 * @param context  The context object describing the current state the converter is in.
 * @param symbol  The symbol the reference type should point to.
 * @param includeParent  Should the name of the parent be provided within the fallback name?
 * @returns A new reference type instance pointing to the given symbol.
 */
export function createReferenceType(context:Context, symbol:ts.Symbol, includeParent?:boolean):ReferenceType {
    var checker = context.checker;
    var id      = context.getSymbolID(symbol);
    var name    = checker.symbolToString(symbol);

    if (includeParent && symbol.parent) {
        name = checker.symbolToString(symbol.parent) + '.' + name;
    }

    return new ReferenceType(name, id);
}


/**
 * Create a new signature reflection from the given node.
 *
 * @param context  The context object describing the current state the converter is in.
 * @param node  The TypeScript node containing the signature declaration that should be reflected.
 * @param name  The name of the function or method this signature belongs to.
 * @param kind  The desired kind of the reflection.
 * @returns The newly created signature reflection describing the given node.
 */
export function createSignature(context:Context, node:ts.SignatureDeclaration, name:string, kind:ReflectionKind):SignatureReflection {
    var container = <DeclarationReflection>context.scope;
    if (!(container instanceof ContainerReflection)) {
        throw new Error('Expected container reflection.');
    }

    var signature = new SignatureReflection(container, name, kind);
    context.registerReflection(signature, node);
    context.withScope(signature, node.typeParameters, true, () => {
        node.parameters.forEach((parameter:ts.ParameterDeclaration) => {
            createParameter(context, parameter);
        });

        signature.type = extractSignatureType(context, node);

        if (container.inheritedFrom) {
            signature.inheritedFrom = createReferenceType(context, node.symbol, true);
        }
    });

    context.trigger(Converter.EVENT_CREATE_SIGNATURE, signature, node);
    return signature;
}


/**
 * Extract the return type of the given signature declaration.
 *
 * @param context  The context object describing the current state the converter is in.
 * @param node  The signature declaration whose return type should be determined.
 * @returns The return type reflection of the given signature.
 */
function extractSignatureType(context:Context, node:ts.SignatureDeclaration):Type {
    var checker = context.checker;
    if (node.kind & ts.SyntaxKind.CallSignature || node.kind & ts.SyntaxKind.CallExpression) {
        try {
            var signature = checker.getSignatureFromDeclaration(node);
            return convertType(context, node.type, checker.getReturnTypeOfSignature(signature));
        } catch (error) {}
    }

    if (node.type) {
        return convertType(context, node.type);
    } else {
        return convertType(context, node);
    }
}


/**
 * Create a parameter reflection for the given node.
 *
 * @param context  The context object describing the current state the converter is in.
 * @param node  The parameter node that should be reflected.
 * @returns The newly created parameter reflection.
 */
function createParameter(context:Context, node:ts.ParameterDeclaration):ParameterReflection {
    var signature = <SignatureReflection>context.scope;
    if (!(signature instanceof SignatureReflection)) {
        throw new Error('Expected signature reflection.');
    }

    var parameter = new ParameterReflection(signature, node.symbol.name, ReflectionKind.Parameter);
    context.registerReflection(parameter, node);
    context.withScope(parameter, () => {
        if (ts.isBindingPattern(node.name)) {
            parameter.type = convertDestructuringType(context, <ts.BindingPattern>node.name);
            parameter.name = '__namedParameters'
        } else {
            parameter.type = convertType(context, node.type, context.getTypeAtLocation(node));
        }

        parameter.defaultValue = getDefaultValue(node);
        parameter.setFlag(ReflectionFlag.Optional, !!node.questionToken);
        parameter.setFlag(ReflectionFlag.Rest, !!node.dotDotDotToken);
        parameter.setFlag(ReflectionFlag.DefaultValue, !!parameter.defaultValue);

        if (!signature.parameters) signature.parameters = [];
        signature.parameters.push(parameter);
    });

    context.trigger(Converter.EVENT_CREATE_PARAMETER, parameter, node);
    return parameter;
}


/**
 * Create a type parameter reflection for the given node.
 *
 * @param context  The context object describing the current state the converter is in.
 * @param node  The type parameter node that should be reflected.
 * @returns The newly created type parameter reflection.
 */
export function createTypeParameter(context:Context, node:ts.TypeParameterDeclaration):TypeParameterType {
    var typeParameter = new TypeParameterType();
    typeParameter.name = node.symbol.name;
    if (node.constraint) {
        typeParameter.constraint = convertType(context, node.constraint);
    }

    var reflection = <ITypeParameterContainer>context.scope;
    var typeParameterReflection = new TypeParameterReflection(reflection, typeParameter);

    if (!reflection.typeParameters) reflection.typeParameters = [];
    reflection.typeParameters.push(typeParameterReflection);

    context.registerReflection(typeParameterReflection, node);
    context.trigger(Converter.EVENT_CREATE_TYPE_PARAMETER, typeParameterReflection, node);

    return typeParameter;
}
